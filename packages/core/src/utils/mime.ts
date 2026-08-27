import { getBasename } from "../paths/resolver.js";

const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  ts: "application/typescript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

/**
 * Infers standard MIME content-type based on the virtual path extension.
 */
export function lookupMimeType(filePath: string, fallback: string = "application/octet-stream"): string {
  const basename = getBasename(filePath);
  const dotIndex = basename.lastIndexOf(".");

  if (dotIndex === -1 || dotIndex === basename.length - 1) {
    return fallback;
  }

  const ext = basename.slice(dotIndex + 1).toLowerCase();
  return MIME_MAP[ext] || fallback;
}
