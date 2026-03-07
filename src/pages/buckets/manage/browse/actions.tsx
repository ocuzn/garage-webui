import { FolderPlus, UploadIcon, X } from "lucide-react";
import Button from "@/components/ui/button";
import { useMultipartUpload } from "./hooks";
import { toast } from "sonner";
import { handleError } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useBucketContext } from "../context";
import { useDisclosure } from "@/hooks/useDisclosure";
import { Modal } from "react-daisyui";
import { createFolderSchema, CreateFolderSchema } from "./schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { InputField } from "@/components/ui/input";
import { useEffect } from "react";
import { usePutObject } from "./hooks";
import { MultipartUploadProgress } from "./types";

type Props = {
  prefix: string;
};

const UploadProgressPanel = ({
  uploads,
  onCancel,
  onClear,
}: {
  uploads: Map<string, MultipartUploadProgress>;
  onCancel: (fileName: string) => void;
  onClear: () => void;
}) => {
  if (uploads.size === 0) return null;

  const entries = Array.from(uploads.values());
  const hasCompleted = entries.some(
    (u) => u.status === "completed" || u.status === "error"
  );

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-base-200 rounded-lg shadow-lg p-3 z-50 max-h-64 overflow-y-auto">
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-semibold">Uploads</span>
        {hasCompleted && (
          <button
            className="text-xs text-base-content/60 hover:text-base-content"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
      {entries.map((upload) => {
        const percent =
          upload.total > 0
            ? Math.round((upload.loaded / upload.total) * 100)
            : 0;
        return (
          <div key={upload.fileName} className="mb-2">
            <div className="flex justify-between items-center text-xs">
              <span className="truncate flex-1" title={upload.fileName}>
                {upload.fileName}
              </span>
              {upload.status === "uploading" && (
                <button
                  className="ml-2 text-error hover:text-error-focus"
                  onClick={() => onCancel(upload.fileName)}
                  title="Cancel"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <progress
                className={`progress w-full ${
                  upload.status === "completed"
                    ? "progress-success"
                    : upload.status === "error"
                      ? "progress-error"
                      : "progress-primary"
                }`}
                value={percent}
                max={100}
              />
              <span className="text-xs w-10 text-right">{percent}%</span>
            </div>
            {upload.status === "error" && upload.error && (
              <span className="text-xs text-error">{upload.error}</span>
            )}
          </div>
        );
      })}
    </div>
  );
};

const Actions = ({ prefix }: Props) => {
  const { bucketName } = useBucketContext();
  const queryClient = useQueryClient();

  const { uploads, uploadFile, cancelUpload, clearCompleted } =
    useMultipartUpload(bucketName, {
      onSuccess: () => {
        toast.success("File uploaded!");
        queryClient.invalidateQueries({ queryKey: ["browse", bucketName] });
      },
      onError: handleError,
    });

  const onUploadFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;

    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files?.length) {
        return;
      }

      if (files.length > 20) {
        toast.error("You can only upload up to 20 files at a time");
        return;
      }

      for (const file of files) {
        const key = prefix + file.name;
        uploadFile(key, file);
      }
    };

    input.click();
    input.remove();
  };

  return (
    <>
      <CreateFolderAction prefix={prefix} />
      <Button
        icon={UploadIcon}
        color="ghost"
        title="Upload File"
        onClick={onUploadFile}
      />
      <UploadProgressPanel
        uploads={uploads}
        onCancel={cancelUpload}
        onClear={clearCompleted}
      />
    </>
  );
};

type CreateFolderActionProps = {
  prefix: string;
};

const CreateFolderAction = ({ prefix }: CreateFolderActionProps) => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const { bucketName } = useBucketContext();
  const queryClient = useQueryClient();

  const form = useForm<CreateFolderSchema>({
    resolver: zodResolver(createFolderSchema),
    defaultValues: { name: "" },
  });

  useEffect(() => {
    if (isOpen) form.setFocus("name");
  }, [isOpen]);

  const createFolder = usePutObject(bucketName, {
    onSuccess: () => {
      toast.success("Folder created!");
      queryClient.invalidateQueries({ queryKey: ["browse", bucketName] });
      onClose();
      form.reset();
    },
    onError: handleError,
  });

  const onSubmit = form.handleSubmit((values) => {
    createFolder.mutate({ key: `${prefix}${values.name}/`, file: null });
  });

  return (
    <>
      <Button
        icon={FolderPlus}
        color="ghost"
        onClick={onOpen}
        title="Create Folder"
      />

      <Modal open={isOpen}>
        <Modal.Header>Create Folder</Modal.Header>

        <Modal.Body>
          <form onSubmit={onSubmit}>
            <InputField form={form} name="name" title="Name" />
          </form>
        </Modal.Body>

        <Modal.Actions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            color="primary"
            onClick={onSubmit}
            disabled={createFolder.isPending}
          >
            Submit
          </Button>
        </Modal.Actions>
      </Modal>
    </>
  );
};

export default Actions;
