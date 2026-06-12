// Browser-side helpers for uploading workflow attachments to Supabase Storage.
//
// Why we upload immediately on file selection instead of holding File blobs
// in memory: blobs don't survive a full page navigation, sessionStorage
// can't hold binary, and there's no way to "save the workflow and come back
// later" if the only copy of the file is a JS reference in this tab. Pushing
// to Supabase Storage on selection means the attachment is durable from
// pick -> review -> monday push (or come-back-later edit).
//
// The bucket "quote-attachments" must exist in the shared Supabase project
// and be public-read so the monday push (server-side) can fetch each file
// by URL.

import { supabase } from "./supabase";

export const ATTACHMENTS_BUCKET = "quote-attachments";

export type WorkflowAttachment = {
    path: string;
    name: string;
    size: number;
    type: string;
    url: string;
};

function uid(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
          return crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function safeFilename(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export async function uploadAttachment(
    workflowUid: string,
    file: File,
  ): Promise<WorkflowAttachment | null> {
    if (!supabase) {
          console.error("Supabase client not configured; cannot upload attachment.");
          return null;
    }
    const path = `workflows/${workflowUid}/${uid()}-${safeFilename(file.name)}`;
    const { error } = await supabase.storage
      .from(ATTACHMENTS_BUCKET)
      .upload(path, file, {
              cacheControl: "3600",
              upsert: false,
              contentType: file.type || "application/octet-stream",
      });
    if (error) {
          console.error("uploadAttachment failed:", error.message);
          return null;
    }
    const { data: pub } = supabase.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(path);
    return {
          path,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
          url: pub.publicUrl,
    };
}

export async function removeAttachment(path: string): Promise<boolean> {
    if (!supabase) return false;
    const { error } = await supabase.storage.from(ATTACHMENTS_BUCKET).remove([path]);
    if (error) {
          console.error("removeAttachment failed:", error.message);
          return false;
    }
    return true;
}
