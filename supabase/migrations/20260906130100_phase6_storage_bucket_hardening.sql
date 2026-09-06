-- Phase 6 (M-2): storage bucket MIME allowlist hardening
-- Tighten growlith-private bucket from allowed_mime_types = null (allow all)
-- to an explicit allowlist. SVG/HTML are excluded to prevent inline script
-- execution when objects are accidentally served with inline disposition.
-- TXT/CSV are allowed; size limit enforced at application layer (10 MiB per file).

-- Ensure bucket exists before update (idempotent)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'growlith-private',
  'growlith-private',
  false,
  10485760,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'text/csv',
    'text/plain',
    'application/zip',
    'application/x-zip-compressed',
    'application/gzip',
    'video/mp4',
    'video/quicktime'
  ]
)
on conflict (id) do update
set
  file_size_limit = 10485760,
  allowed_mime_types = array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'text/csv',
    'text/plain',
    'application/zip',
    'application/x-zip-compressed',
    'application/gzip',
    'video/mp4',
    'video/quicktime'
  ];
