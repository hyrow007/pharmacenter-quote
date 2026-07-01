// Browser-side helpers for uploading workflow attachments to Supabase Storage.
//
// Why we upload immediately on file selection instead of holding File blobs
// in memory: blobs don't survive a full page navigation, sessionStorage
// can't hold binary, and there's no way to "save the workflow and come back
// later" if the only copy of the file is a JS reference in this tab. Pushing
// to Supabase Storage on selection means the attachment is durable from
// pick → review → monday push (or come-back-later edit).
//
// The bucket "quote-attachments" must exist in the shared Supabase project
// and be public-read so the monday push (server-side) can fetch each file
// by URL. File paths are uuid-prefixed so listing the bucket doesn't leak
// anything useful — knowing the bucket name isn't enough to discover files.

import { supabase } from "./supabase";

export const ATTACHMENTS_BUCKET = "quote-attachments";

export type WorkflowAttachment = {
  // Storage path inside the bucket (e.g. "workflows/<uid>/<uuid>-spec.pdf").
  path: string;
  // Original filename for UI display + monday upload.
  name: string;
  size: number;
  type: string;
  // Public URL — what the server uses to download for the monday push.
  url: string;
};

// Lightweight uuid (no need for a dep — these IDs are non-cryptographic).
function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Sanitise filenames so Supabase Storage doesn't reject them. Storage keys
// disallow most non-ASCII characters; we keep letters/numbers/.-_ and turn
// everything else into "_".
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/**
 * Upload a single file to the workflow's storage prefix. Returns null on
 * error and logs to console (the caller can decide whether to retry / surface).
 */
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

/**
 * Remove an attachment from Supabase Storage. Used when the user clicks the
 * "×" next to an attachment, and (optionally) after a successful monday push
 * to clean up.
 */
export async function removeAttachment(path: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.storage.from(ATTACHMENTS_BUCKET).remove([path]);
  if (error) {
    console.error("removeAttachment failed:", error.message);
    return false;
  }
  return true;
}
