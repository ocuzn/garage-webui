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

const MULTIPART_CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB

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
          await api.put(`/browse/${bucket}/${key}`, { body: formData });
          updateProgress(fileName, { loaded: file.size, status: "completed" });
          options?.onSuccess?.();
        } catch (err) {
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

      try {
        // 1. Create multipart upload
        console.log("[multipart] Creating upload for", key, "size:", file.size);
        const createRes = await api.post(
          `/browse/${bucket}/multipart/create`,
          {
            body: { key, contentType: file.type || "application/octet-stream" },
          }
        );
        const uploadId = createRes.uploadId;
        console.log("[multipart] Upload created, id:", uploadId);

        // 2. Upload parts
        const totalParts = Math.ceil(file.size / MULTIPART_CHUNK_SIZE);
        const parts: { partNumber: number; etag: string }[] = [];
        let uploadedBytes = 0;

        for (let i = 0; i < totalParts; i++) {
          // Check for abort
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

          console.log(`[multipart] Uploading part ${i + 1}/${totalParts}, size: ${end - start}`);
          const partRes = await api.put(
            `/browse/${bucket}/multipart/upload?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${i + 1}`,
            { body: formData }
          );
          console.log(`[multipart] Part ${i + 1} done, etag:`, partRes.etag);

          parts.push({ partNumber: i + 1, etag: partRes.etag });
          uploadedBytes += end - start;
          updateProgress(fileName, { loaded: uploadedBytes });
        }

        // 3. Complete multipart upload
        await api.post(`/browse/${bucket}/multipart/complete`, {
          body: { key, uploadId, parts },
        });

        updateProgress(fileName, { loaded: file.size, status: "completed" });
        options?.onSuccess?.();
      } catch (err) {
        console.error("[multipart] Upload failed:", err);
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
