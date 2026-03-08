import api from "@/lib/api";
import {
  useMutation,
  UseMutationOptions,
  useQuery,
} from "@tanstack/react-query";
import {
  GetObjectsResult,
  MultipartUploadProgress,
  PutObjectPayload,
  UseBrowserObjectOptions,
} from "./types";
import { useCallback, useRef, useState } from "react";

export const useBrowseObjects = (
  bucket: string,
  options?: UseBrowserObjectOptions
) => {
  return useQuery({
    queryKey: ["browse", bucket, options],
    queryFn: () =>
      api.get<GetObjectsResult>(`/browse/${bucket}`, { params: options }),
  });
};

export const usePutObject = (
  bucket: string,
  options?: UseMutationOptions<any, Error, PutObjectPayload>
) => {
  return useMutation({
    mutationFn: async (body) => {
      const formData = new FormData();
      if (body.file) {
        formData.append("file", body.file);
      }

      return api.put(`/browse/${bucket}/${body.key}`, { body: formData });
    },
    ...options,
  });
};

const MULTIPART_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  label: string = ""
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(
        `[multipart] ${label} attempt ${attempt}/${retries} failed:`,
        err
      );
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error("unreachable");
}

export const useMultipartUpload = (
  bucket: string,
  options?: {
    onSuccess?: () => void;
    onError?: (error: Error) => void;
  }
) => {
  const [uploads, setUploads] = useState<Map<string, MultipartUploadProgress>>(
    new Map()
  );
  const abortControllers = useRef<Map<string, boolean>>(new Map());

  const updateProgress = (
    fileName: string,
    update: Partial<MultipartUploadProgress>
  ) => {
    setUploads((prev) => {
      const next = new Map(prev);
      const current = next.get(fileName);
      if (current) {
        next.set(fileName, { ...current, ...update });
      }
      return next;
    });
  };

  const uploadFile = useCallback(
    async (key: string, file: File) => {
      const fileName = file.name;
      console.log(
        `[multipart] Starting upload: ${fileName}, size: ${file.size}, chunk threshold: ${MULTIPART_CHUNK_SIZE}`
      );

      // For small files, use simple upload
      if (file.size <= MULTIPART_CHUNK_SIZE) {
        setUploads((prev) => {
          const next = new Map(prev);
          next.set(fileName, {
            fileName,
            loaded: 0,
            total: file.size,
            status: "uploading",
          });
          return next;
        });

        try {
          const formData = new FormData();
          formData.append("file", file);
          await fetchWithRetry(
            () => api.put(`/browse/${bucket}/${key}`, { body: formData }),
            MAX_RETRIES,
            `PUT ${fileName}`
          );
          updateProgress(fileName, { loaded: file.size, status: "completed" });
          options?.onSuccess?.();
        } catch (err) {
          console.error("[multipart] Simple upload failed:", err);
          updateProgress(fileName, {
            status: "error",
            error: (err as Error).message,
          });
          options?.onError?.(err as Error);
        }
        return;
      }

      // Multipart upload
      setUploads((prev) => {
        const next = new Map(prev);
        next.set(fileName, {
          fileName,
          loaded: 0,
          total: file.size,
          status: "uploading",
        });
        return next;
      });
      abortControllers.current.set(fileName, false);

      let uploadId: string | undefined;

      try {
        // 1. Create multipart upload
        console.log("[multipart] Creating upload for", key);
        const createRes = await fetchWithRetry(
          () =>
            api.post(`/browse/${bucket}/multipart/create`, {
              body: {
                key,
                contentType: file.type || "application/octet-stream",
              },
            }),
          MAX_RETRIES,
          "CreateMultipartUpload"
        );
        uploadId = createRes.uploadId;
        console.log("[multipart] Upload created, id:", uploadId);

        // 2. Upload parts
        const totalParts = Math.ceil(file.size / MULTIPART_CHUNK_SIZE);
        const parts: { partNumber: number; etag: string }[] = [];
        let uploadedBytes = 0;

        for (let i = 0; i < totalParts; i++) {
          if (abortControllers.current.get(fileName)) {
            await api.post(`/browse/${bucket}/multipart/abort`, {
              body: { key, uploadId },
            });
            updateProgress(fileName, { status: "error", error: "Cancelled" });
            return;
          }

          const start = i * MULTIPART_CHUNK_SIZE;
          const end = Math.min(start + MULTIPART_CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);

          const formData = new FormData();
          formData.append("file", chunk, fileName);

          console.log(
            `[multipart] Uploading part ${i + 1}/${totalParts}, size: ${end - start}`
          );
          const partRes = await fetchWithRetry(
            () =>
              api.put(
                `/browse/${bucket}/multipart/upload?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId!)}&partNumber=${i + 1}`,
                { body: formData }
              ),
            MAX_RETRIES,
            `UploadPart ${i + 1}/${totalParts}`
          );
          console.log(`[multipart] Part ${i + 1} done, etag:`, partRes.etag);

          parts.push({ partNumber: i + 1, etag: partRes.etag });
          uploadedBytes += end - start;
          updateProgress(fileName, { loaded: uploadedBytes });
        }

        // 3. Complete multipart upload
        console.log("[multipart] Completing upload");
        await fetchWithRetry(
          () =>
            api.post(`/browse/${bucket}/multipart/complete`, {
              body: { key, uploadId, parts },
            }),
          MAX_RETRIES,
          "CompleteMultipartUpload"
        );

        updateProgress(fileName, { loaded: file.size, status: "completed" });
        console.log("[multipart] Upload complete!");
        options?.onSuccess?.();
      } catch (err) {
        console.error("[multipart] Upload failed:", err);
        // Try to abort if we have an uploadId
        if (uploadId) {
          try {
            await api.post(`/browse/${bucket}/multipart/abort`, {
              body: { key, uploadId },
            });
          } catch {
            // ignore abort errors
          }
        }
        updateProgress(fileName, {
          status: "error",
          error: (err as Error).message,
        });
        options?.onError?.(err as Error);
      }
    },
    [bucket, options]
  );

  const cancelUpload = useCallback((fileName: string) => {
    abortControllers.current.set(fileName, true);
  }, []);

  const clearCompleted = useCallback(() => {
    setUploads((prev) => {
      const next = new Map(prev);
      for (const [key, value] of next) {
        if (value.status === "completed" || value.status === "error") {
          next.delete(key);
        }
      }
      return next;
    });
  }, []);

  return { uploads, uploadFile, cancelUpload, clearCompleted };
};

export const useDeleteObject = (
  bucket: string,
  options?: UseMutationOptions<any, Error, { key: string; recursive?: boolean }>
) => {
  return useMutation({
    mutationFn: (data) =>
      api.delete(`/browse/${bucket}/${data.key}`, {
        params: { recursive: data.recursive },
      }),
    ...options,
  });
};
