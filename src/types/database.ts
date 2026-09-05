/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  GENERATED FILE — DO NOT EDIT BY HAND                                     │
 * │                                                                           │
 * │  Regenerate with:  npm run db:types        (Supabase CLI, needs Docker)   │
 * │                or: npm run db:types:pg     (direct connection, no Docker) │
 * │                                                                           │
 * │  Committed so CI can fail when the schema and these types disagree,       │
 * │  rather than letting the drift reach a developer's machine                │
 * │  (ADR-0004: no ORM, generated types instead).                             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Generated from the Phase 2 schema: 24 tables, 36 enums.
 *
 * Both generators read the same catalog and emit the same shape, so call sites
 * cannot tell which produced this file. Output is ordered by name, making
 * regeneration byte-stable and "no diff" a meaningful CI assertion.
 */

/** Any JSONB value, as emitted by the Supabase type generator. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      audit_events: {
        Row: {
          id: number;
          occurred_at: string;
          organization_id: string | null;
          actor_user_id: string | null;
          actor_role: string | null;
          actor_ip: string | null;
          request_id: string | null;
          entity_kind: Database['public']['Enums']['entity_kind'];
          entity_id: string;
          action: Database['public']['Enums']['audit_action'];
          severity: Database['public']['Enums']['audit_severity'];
          changed_fields: string[] | null;
          before: Json | null;
          after: Json | null;
          reason: string | null;
        };
        Insert: {
          id?: number;
          occurred_at?: string;
          organization_id?: string | null;
          actor_user_id?: string | null;
          actor_role?: string | null;
          actor_ip?: string | null;
          request_id?: string | null;
          entity_kind: Database['public']['Enums']['entity_kind'];
          entity_id: string;
          action: Database['public']['Enums']['audit_action'];
          severity?: Database['public']['Enums']['audit_severity'];
          changed_fields?: string[] | null;
          before?: Json | null;
          after?: Json | null;
          reason?: string | null;
        };
        Update: {
          id?: number;
          occurred_at?: string;
          organization_id?: string | null;
          actor_user_id?: string | null;
          actor_role?: string | null;
          actor_ip?: string | null;
          request_id?: string | null;
          entity_kind?: Database['public']['Enums']['entity_kind'];
          entity_id?: string;
          action?: Database['public']['Enums']['audit_action'];
          severity?: Database['public']['Enums']['audit_severity'];
          changed_fields?: string[] | null;
          before?: Json | null;
          after?: Json | null;
          reason?: string | null;
        };
      };
      comments: {
        Row: {
          id: string;
          organization_id: string;
          project_id: string | null;
          deliverable_id: string | null;
          task_id: string | null;
          parent_comment_id: string | null;
          author_user_id: string;
          body: string;
          is_internal: boolean;
          edited_at: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          project_id?: string | null;
          deliverable_id?: string | null;
          task_id?: string | null;
          parent_comment_id?: string | null;
          author_user_id: string;
          body: string;
          is_internal?: boolean;
          edited_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          project_id?: string | null;
          deliverable_id?: string | null;
          task_id?: string | null;
          parent_comment_id?: string | null;
          author_user_id?: string;
          body?: string;
          is_internal?: boolean;
          edited_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      deliverable_versions: {
        Row: {
          id: string;
          organization_id: string;
          deliverable_id: string;
          version_number: number;
          summary: string | null;
          status: Database['public']['Enums']['deliverable_status'];
          submitted_by: string | null;
          submitted_at: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
          review_outcome: Database['public']['Enums']['review_outcome'] | null;
          review_notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          deliverable_id: string;
          version_number: number;
          summary?: string | null;
          status: Database['public']['Enums']['deliverable_status'];
          submitted_by?: string | null;
          submitted_at?: string;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          review_outcome?: Database['public']['Enums']['review_outcome'] | null;
          review_notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          deliverable_id?: string;
          version_number?: number;
          summary?: string | null;
          status?: Database['public']['Enums']['deliverable_status'];
          submitted_by?: string | null;
          submitted_at?: string;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          review_outcome?: Database['public']['Enums']['review_outcome'] | null;
          review_notes?: string | null;
          created_at?: string;
        };
      };
      deliverables: {
        Row: {
          id: string;
          organization_id: string;
          project_id: string;
          title: string;
          description: string | null;
          deliverable_type: Database['public']['Enums']['deliverable_type'];
          status: Database['public']['Enums']['deliverable_status'];
          client_visible: boolean;
          current_version: number;
          revision_count: number;
          due_date: string | null;
          submitted_at: string | null;
          approved_at: string | null;
          approved_by: string | null;
          owner_user_id: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          project_id: string;
          title: string;
          description?: string | null;
          deliverable_type: Database['public']['Enums']['deliverable_type'];
          status?: Database['public']['Enums']['deliverable_status'];
          client_visible?: boolean;
          current_version?: number;
          revision_count?: number;
          due_date?: string | null;
          submitted_at?: string | null;
          approved_at?: string | null;
          approved_by?: string | null;
          owner_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          project_id?: string;
          title?: string;
          description?: string | null;
          deliverable_type?: Database['public']['Enums']['deliverable_type'];
          status?: Database['public']['Enums']['deliverable_status'];
          client_visible?: boolean;
          current_version?: number;
          revision_count?: number;
          due_date?: string | null;
          submitted_at?: string | null;
          approved_at?: string | null;
          approved_by?: string | null;
          owner_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      engagements: {
        Row: {
          id: string;
          organization_id: string;
          code: string;
          name: string;
          engagement_type: Database['public']['Enums']['engagement_type'];
          status: Database['public']['Enums']['engagement_status'];
          currency: Database['public']['Enums']['currency_code'];
          contract_value: number | null;
          monthly_retainer: number | null;
          start_date: string;
          end_date: string | null;
          renewal_date: string | null;
          account_manager_user_id: string | null;
          signed_at: string | null;
          notes_internal: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          code: string;
          name: string;
          engagement_type: Database['public']['Enums']['engagement_type'];
          status?: Database['public']['Enums']['engagement_status'];
          currency: Database['public']['Enums']['currency_code'];
          contract_value?: number | null;
          monthly_retainer?: number | null;
          start_date: string;
          end_date?: string | null;
          renewal_date?: string | null;
          account_manager_user_id?: string | null;
          signed_at?: string | null;
          notes_internal?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          code?: string;
          name?: string;
          engagement_type?: Database['public']['Enums']['engagement_type'];
          status?: Database['public']['Enums']['engagement_status'];
          currency?: Database['public']['Enums']['currency_code'];
          contract_value?: number | null;
          monthly_retainer?: number | null;
          start_date?: string;
          end_date?: string | null;
          renewal_date?: string | null;
          account_manager_user_id?: string | null;
          signed_at?: string | null;
          notes_internal?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      files: {
        Row: {
          id: string;
          organization_id: string;
          storage_bucket: string;
          storage_path: string;
          file_name: string;
          mime_type: string;
          size_bytes: number;
          checksum_sha256: string | null;
          file_kind: Database['public']['Enums']['file_kind'];
          client_visible: boolean;
          uploaded_by: string;
          virus_scan_status: Database['public']['Enums']['scan_status'];
          scanned_at: string | null;
          project_id: string | null;
          deliverable_id: string | null;
          deliverable_version_id: string | null;
          task_id: string | null;
          report_id: string | null;
          comment_id: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          storage_bucket?: string;
          storage_path: string;
          file_name: string;
          mime_type: string;
          size_bytes: number;
          checksum_sha256?: string | null;
          file_kind?: Database['public']['Enums']['file_kind'];
          client_visible?: boolean;
          uploaded_by: string;
          virus_scan_status?: Database['public']['Enums']['scan_status'];
          scanned_at?: string | null;
          project_id?: string | null;
          deliverable_id?: string | null;
          deliverable_version_id?: string | null;
          task_id?: string | null;
          report_id?: string | null;
          comment_id?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          storage_bucket?: string;
          storage_path?: string;
          file_name?: string;
          mime_type?: string;
          size_bytes?: number;
          checksum_sha256?: string | null;
          file_kind?: Database['public']['Enums']['file_kind'];
          client_visible?: boolean;
          uploaded_by?: string;
          virus_scan_status?: Database['public']['Enums']['scan_status'];
          scanned_at?: string | null;
          project_id?: string | null;
          deliverable_id?: string | null;
          deliverable_version_id?: string | null;
          task_id?: string | null;
          report_id?: string | null;
          comment_id?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      invitations: {
        Row: {
          id: string;
          email: string;
          organization_id: string | null;
          organization_role: Database['public']['Enums']['organization_role'] | null;
          platform_role: Database['public']['Enums']['platform_role'] | null;
          invited_by: string;
          token_hash: string;
          status: Database['public']['Enums']['invitation_status'];
          expires_at: string;
          accepted_at: string | null;
          accepted_user_id: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          resent_count: number;
          last_sent_at: string;
          message: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          organization_id?: string | null;
          organization_role?: Database['public']['Enums']['organization_role'] | null;
          platform_role?: Database['public']['Enums']['platform_role'] | null;
          invited_by: string;
          token_hash: string;
          status?: Database['public']['Enums']['invitation_status'];
          expires_at: string;
          accepted_at?: string | null;
          accepted_user_id?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          resent_count?: number;
          last_sent_at?: string;
          message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          organization_id?: string | null;
          organization_role?: Database['public']['Enums']['organization_role'] | null;
          platform_role?: Database['public']['Enums']['platform_role'] | null;
          invited_by?: string;
          token_hash?: string;
          status?: Database['public']['Enums']['invitation_status'];
          expires_at?: string;
          accepted_at?: string | null;
          accepted_user_id?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          resent_count?: number;
          last_sent_at?: string;
          message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      metrics: {
        Row: {
          id: string;
          organization_id: string;
          service_id: string | null;
          service_line: Database['public']['Enums']['service_line'] | null;
          metric_key: Database['public']['Enums']['metric_key'];
          metric_date: string;
          value: number;
          unit: Database['public']['Enums']['metric_unit'];
          currency: Database['public']['Enums']['currency_code'] | null;
          source: Database['public']['Enums']['metric_source'];
          ingested_at: string;
          source_ref: string | null;
          created_at: string;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          service_id?: string | null;
          service_line?: Database['public']['Enums']['service_line'] | null;
          metric_key: Database['public']['Enums']['metric_key'];
          metric_date: string;
          value: number;
          unit: Database['public']['Enums']['metric_unit'];
          currency?: Database['public']['Enums']['currency_code'] | null;
          source?: Database['public']['Enums']['metric_source'];
          ingested_at?: string;
          source_ref?: string | null;
          created_at?: string;
          created_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          service_id?: string | null;
          service_line?: Database['public']['Enums']['service_line'] | null;
          metric_key?: Database['public']['Enums']['metric_key'];
          metric_date?: string;
          value?: number;
          unit?: Database['public']['Enums']['metric_unit'];
          currency?: Database['public']['Enums']['currency_code'] | null;
          source?: Database['public']['Enums']['metric_source'];
          ingested_at?: string;
          source_ref?: string | null;
          created_at?: string;
          created_by?: string | null;
        };
      };
      notifications: {
        Row: {
          id: string;
          recipient_user_id: string;
          organization_id: string | null;
          notification_type: Database['public']['Enums']['notification_type'];
          severity: Database['public']['Enums']['notification_severity'];
          title: string;
          body: string | null;
          subject_entity: Database['public']['Enums']['entity_kind'] | null;
          subject_id: string | null;
          action_url: string | null;
          read_at: string | null;
          archived_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          recipient_user_id: string;
          organization_id?: string | null;
          notification_type: Database['public']['Enums']['notification_type'];
          severity?: Database['public']['Enums']['notification_severity'];
          title: string;
          body?: string | null;
          subject_entity?: Database['public']['Enums']['entity_kind'] | null;
          subject_id?: string | null;
          action_url?: string | null;
          read_at?: string | null;
          archived_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          recipient_user_id?: string;
          organization_id?: string | null;
          notification_type?: Database['public']['Enums']['notification_type'];
          severity?: Database['public']['Enums']['notification_severity'];
          title?: string;
          body?: string | null;
          subject_entity?: Database['public']['Enums']['entity_kind'] | null;
          subject_id?: string | null;
          action_url?: string | null;
          read_at?: string | null;
          archived_at?: string | null;
          created_at?: string;
        };
      };
      organization_memberships: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          role: Database['public']['Enums']['organization_role'];
          status: Database['public']['Enums']['membership_status'];
          is_primary_contact: boolean;
          job_title: string | null;
          invited_by: string | null;
          joined_at: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role: Database['public']['Enums']['organization_role'];
          status?: Database['public']['Enums']['membership_status'];
          is_primary_contact?: boolean;
          job_title?: string | null;
          invited_by?: string | null;
          joined_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          role?: Database['public']['Enums']['organization_role'];
          status?: Database['public']['Enums']['membership_status'];
          is_primary_contact?: boolean;
          job_title?: string | null;
          invited_by?: string | null;
          joined_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      organization_settings: {
        Row: {
          organization_id: string;
          brand_primary_color: string | null;
          logo_file_id: string | null;
          default_report_cadence: Database['public']['Enums']['report_cadence'];
          notify_on_deliverable_ready: boolean;
          notify_on_report_published: boolean;
          require_approval_for_publish: boolean;
          timezone: string;
          created_at: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          organization_id: string;
          brand_primary_color?: string | null;
          logo_file_id?: string | null;
          default_report_cadence?: Database['public']['Enums']['report_cadence'];
          notify_on_deliverable_ready?: boolean;
          notify_on_report_published?: boolean;
          require_approval_for_publish?: boolean;
          timezone?: string;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          organization_id?: string;
          brand_primary_color?: string | null;
          logo_file_id?: string | null;
          default_report_cadence?: Database['public']['Enums']['report_cadence'];
          notify_on_deliverable_ready?: boolean;
          notify_on_report_published?: boolean;
          require_approval_for_publish?: boolean;
          timezone?: string;
          created_at?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
      };
      organizations: {
        Row: {
          id: string;
          slug: string;
          legal_name: string;
          display_name: string;
          region: Database['public']['Enums']['region_code'];
          industry: string | null;
          website_url: string | null;
          status: Database['public']['Enums']['org_status'];
          primary_currency: Database['public']['Enums']['currency_code'];
          account_manager_user_id: string | null;
          onboarded_at: string | null;
          churned_at: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          slug: string;
          legal_name: string;
          display_name: string;
          region: Database['public']['Enums']['region_code'];
          industry?: string | null;
          website_url?: string | null;
          status?: Database['public']['Enums']['org_status'];
          primary_currency: Database['public']['Enums']['currency_code'];
          account_manager_user_id?: string | null;
          onboarded_at?: string | null;
          churned_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          slug?: string;
          legal_name?: string;
          display_name?: string;
          region?: Database['public']['Enums']['region_code'];
          industry?: string | null;
          website_url?: string | null;
          status?: Database['public']['Enums']['org_status'];
          primary_currency?: Database['public']['Enums']['currency_code'];
          account_manager_user_id?: string | null;
          onboarded_at?: string | null;
          churned_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      platform_role_grants: {
        Row: {
          id: string;
          user_id: string;
          role: Database['public']['Enums']['platform_role'];
          granted_by: string;
          granted_at: string;
          reason: string;
          expires_at: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          revoke_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          role: Database['public']['Enums']['platform_role'];
          granted_by: string;
          granted_at?: string;
          reason: string;
          expires_at?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          revoke_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          role?: Database['public']['Enums']['platform_role'];
          granted_by?: string;
          granted_at?: string;
          reason?: string;
          expires_at?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          revoke_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          display_name: string | null;
          avatar_path: string | null;
          phone: string | null;
          timezone: string;
          locale: string;
          user_type: Database['public']['Enums']['user_type'];
          account_status: Database['public']['Enums']['account_status'];
          last_seen_at: string | null;
          mfa_enrolled_at: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id: string;
          email: string;
          full_name: string;
          display_name?: string | null;
          avatar_path?: string | null;
          phone?: string | null;
          timezone?: string;
          locale?: string;
          user_type: Database['public']['Enums']['user_type'];
          account_status?: Database['public']['Enums']['account_status'];
          last_seen_at?: string | null;
          mfa_enrolled_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string;
          display_name?: string | null;
          avatar_path?: string | null;
          phone?: string | null;
          timezone?: string;
          locale?: string;
          user_type?: Database['public']['Enums']['user_type'];
          account_status?: Database['public']['Enums']['account_status'];
          last_seen_at?: string | null;
          mfa_enrolled_at?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      project_memberships: {
        Row: {
          id: string;
          organization_id: string;
          project_id: string;
          user_id: string;
          project_role: Database['public']['Enums']['project_member_role'];
          allocation_pct: number | null;
          added_by: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          project_id: string;
          user_id: string;
          project_role?: Database['public']['Enums']['project_member_role'];
          allocation_pct?: number | null;
          added_by?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          project_id?: string;
          user_id?: string;
          project_role?: Database['public']['Enums']['project_member_role'];
          allocation_pct?: number | null;
          added_by?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      projects: {
        Row: {
          id: string;
          organization_id: string;
          service_id: string;
          code: string;
          name: string;
          description: string | null;
          status: Database['public']['Enums']['project_status'];
          priority: Database['public']['Enums']['priority'];
          health: Database['public']['Enums']['project_health'];
          lead_user_id: string | null;
          owning_team: Database['public']['Enums']['team'];
          start_date: string | null;
          target_date: string | null;
          completed_at: string | null;
          client_visible: boolean;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          service_id: string;
          code: string;
          name: string;
          description?: string | null;
          status?: Database['public']['Enums']['project_status'];
          priority?: Database['public']['Enums']['priority'];
          health?: Database['public']['Enums']['project_health'];
          lead_user_id?: string | null;
          owning_team: Database['public']['Enums']['team'];
          start_date?: string | null;
          target_date?: string | null;
          completed_at?: string | null;
          client_visible?: boolean;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          service_id?: string;
          code?: string;
          name?: string;
          description?: string | null;
          status?: Database['public']['Enums']['project_status'];
          priority?: Database['public']['Enums']['priority'];
          health?: Database['public']['Enums']['project_health'];
          lead_user_id?: string | null;
          owning_team?: Database['public']['Enums']['team'];
          start_date?: string | null;
          target_date?: string | null;
          completed_at?: string | null;
          client_visible?: boolean;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      report_metrics: {
        Row: {
          id: string;
          organization_id: string;
          report_id: string;
          metric_key: Database['public']['Enums']['metric_key'];
          value: number;
          unit: Database['public']['Enums']['metric_unit'];
          currency: Database['public']['Enums']['currency_code'] | null;
          comparison_value: number | null;
          comparison_label: string | null;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          report_id: string;
          metric_key: Database['public']['Enums']['metric_key'];
          value: number;
          unit: Database['public']['Enums']['metric_unit'];
          currency?: Database['public']['Enums']['currency_code'] | null;
          comparison_value?: number | null;
          comparison_label?: string | null;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          report_id?: string;
          metric_key?: Database['public']['Enums']['metric_key'];
          value?: number;
          unit?: Database['public']['Enums']['metric_unit'];
          currency?: Database['public']['Enums']['currency_code'] | null;
          comparison_value?: number | null;
          comparison_label?: string | null;
          sort_order?: number;
          created_at?: string;
        };
      };
      reports: {
        Row: {
          id: string;
          organization_id: string;
          engagement_id: string | null;
          service_id: string | null;
          title: string;
          report_type: Database['public']['Enums']['report_type'];
          period_start: string;
          period_end: string;
          status: Database['public']['Enums']['report_status'];
          currency: Database['public']['Enums']['currency_code'] | null;
          summary_md: string | null;
          published_at: string | null;
          published_by: string | null;
          client_visible: boolean;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          engagement_id?: string | null;
          service_id?: string | null;
          title: string;
          report_type: Database['public']['Enums']['report_type'];
          period_start: string;
          period_end: string;
          status?: Database['public']['Enums']['report_status'];
          currency?: Database['public']['Enums']['currency_code'] | null;
          summary_md?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          client_visible?: boolean;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          engagement_id?: string | null;
          service_id?: string | null;
          title?: string;
          report_type?: Database['public']['Enums']['report_type'];
          period_start?: string;
          period_end?: string;
          status?: Database['public']['Enums']['report_status'];
          currency?: Database['public']['Enums']['currency_code'] | null;
          summary_md?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          client_visible?: boolean;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      service_lines: {
        Row: {
          code: Database['public']['Enums']['service_line'];
          label: string;
          description: string | null;
          default_team: Database['public']['Enums']['team'];
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          code: Database['public']['Enums']['service_line'];
          label: string;
          description?: string | null;
          default_team: Database['public']['Enums']['team'];
          is_active?: boolean;
          sort_order: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          code?: Database['public']['Enums']['service_line'];
          label?: string;
          description?: string | null;
          default_team?: Database['public']['Enums']['team'];
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      services: {
        Row: {
          id: string;
          organization_id: string;
          engagement_id: string;
          service_line: Database['public']['Enums']['service_line'];
          delivering_team: Database['public']['Enums']['team'];
          name: string;
          scope_summary: string | null;
          status: Database['public']['Enums']['service_status'];
          currency: Database['public']['Enums']['currency_code'];
          fee: number | null;
          fee_model: Database['public']['Enums']['fee_model'];
          start_date: string;
          end_date: string | null;
          lead_user_id: string | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          engagement_id: string;
          service_line: Database['public']['Enums']['service_line'];
          delivering_team: Database['public']['Enums']['team'];
          name: string;
          scope_summary?: string | null;
          status?: Database['public']['Enums']['service_status'];
          currency: Database['public']['Enums']['currency_code'];
          fee?: number | null;
          fee_model?: Database['public']['Enums']['fee_model'];
          start_date: string;
          end_date?: string | null;
          lead_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          engagement_id?: string;
          service_line?: Database['public']['Enums']['service_line'];
          delivering_team?: Database['public']['Enums']['team'];
          name?: string;
          scope_summary?: string | null;
          status?: Database['public']['Enums']['service_status'];
          currency?: Database['public']['Enums']['currency_code'];
          fee?: number | null;
          fee_model?: Database['public']['Enums']['fee_model'];
          start_date?: string;
          end_date?: string | null;
          lead_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      staff_team_memberships: {
        Row: {
          id: string;
          user_id: string;
          team: Database['public']['Enums']['team'];
          is_lead: boolean;
          allocation_pct: number | null;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          team: Database['public']['Enums']['team'];
          is_lead?: boolean;
          allocation_pct?: number | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          team?: Database['public']['Enums']['team'];
          is_lead?: boolean;
          allocation_pct?: number | null;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      status_transitions: {
        Row: {
          entity_kind: Database['public']['Enums']['entity_kind'];
          from_status: string;
          to_status: string;
          allowed_roles: string[];
          requires_reason: boolean;
          is_terminal: boolean;
          description: string | null;
          created_at: string;
        };
        Insert: {
          entity_kind: Database['public']['Enums']['entity_kind'];
          from_status: string;
          to_status: string;
          allowed_roles?: string[];
          requires_reason?: boolean;
          is_terminal?: boolean;
          description?: string | null;
          created_at?: string;
        };
        Update: {
          entity_kind?: Database['public']['Enums']['entity_kind'];
          from_status?: string;
          to_status?: string;
          allowed_roles?: string[];
          requires_reason?: boolean;
          is_terminal?: boolean;
          description?: string | null;
          created_at?: string;
        };
      };
      tasks: {
        Row: {
          id: string;
          organization_id: string;
          project_id: string;
          deliverable_id: string | null;
          title: string;
          description: string | null;
          status: Database['public']['Enums']['task_status'];
          priority: Database['public']['Enums']['priority'];
          assignee_user_id: string | null;
          assigned_team: Database['public']['Enums']['team'] | null;
          due_date: string | null;
          started_at: string | null;
          completed_at: string | null;
          estimated_hours: number | null;
          actual_hours: number | null;
          blocked_reason: string | null;
          position: number;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          project_id: string;
          deliverable_id?: string | null;
          title: string;
          description?: string | null;
          status?: Database['public']['Enums']['task_status'];
          priority?: Database['public']['Enums']['priority'];
          assignee_user_id?: string | null;
          assigned_team?: Database['public']['Enums']['team'] | null;
          due_date?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          estimated_hours?: number | null;
          actual_hours?: number | null;
          blocked_reason?: string | null;
          position?: number;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          project_id?: string;
          deliverable_id?: string | null;
          title?: string;
          description?: string | null;
          status?: Database['public']['Enums']['task_status'];
          priority?: Database['public']['Enums']['priority'];
          assignee_user_id?: string | null;
          assigned_team?: Database['public']['Enums']['team'] | null;
          due_date?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          estimated_hours?: number | null;
          actual_hours?: number | null;
          blocked_reason?: string | null;
          position?: number;
          created_at?: string;
          updated_at?: string;
          created_by?: string | null;
          updated_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
      };
      teams: {
        Row: {
          code: Database['public']['Enums']['team'];
          label: string;
          description: string | null;
          lead_user_id: string | null;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          code: Database['public']['Enums']['team'];
          label: string;
          description?: string | null;
          lead_user_id?: string | null;
          is_active?: boolean;
          sort_order: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          code?: Database['public']['Enums']['team'];
          label?: string;
          description?: string | null;
          lead_user_id?: string | null;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Views: Record<string, never>;
    Functions: {
      auth_platform_role: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      can_access_storage_path: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      current_org_ids: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      current_team_codes: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      has_org_access: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      is_active_account: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      is_client_admin_of: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      is_on_team: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      is_platform_admin: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      is_super_admin: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      org_role_in: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
      storage_path_org_id: {
        Args: Record<string, unknown>;
        Returns: unknown;
      };
    };
    Enums: {
      account_status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
      audit_action:
        | 'CREATE'
        | 'UPDATE'
        | 'SOFT_DELETE'
        | 'RESTORE'
        | 'HARD_DELETE'
        | 'STATUS_CHANGE'
        | 'ROLE_GRANT'
        | 'ROLE_REVOKE'
        | 'LOGIN'
        | 'LOGIN_FAILED'
        | 'INVITE_SENT'
        | 'INVITE_ACCEPTED'
        | 'PERMISSION_DENIED'
        | 'EXPORT'
        | 'FILE_DOWNLOAD';
      audit_severity: 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';
      currency_code: 'USD' | 'GBP' | 'EUR' | 'AED' | 'AUD';
      deliverable_status:
        | 'DRAFT'
        | 'IN_PROGRESS'
        | 'INTERNAL_REVIEW'
        | 'SUBMITTED'
        | 'CLIENT_REVIEW'
        | 'REVISION_REQUESTED'
        | 'APPROVED'
        | 'PUBLISHED'
        | 'CANCELLED';
      deliverable_type:
        | 'REPORT'
        | 'PAGE_TEMPLATE_SET'
        | 'CAMPAIGN'
        | 'VIDEO'
        | 'AUTOMATION'
        | 'AUDIT'
        | 'DESIGN'
        | 'DOCUMENT'
        | 'OTHER';
      engagement_status:
        'DRAFT' | 'PENDING_SIGNATURE' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
      engagement_type: 'RETAINER' | 'PROJECT' | 'ADVISORY';
      entity_kind:
        | 'organization'
        | 'engagement'
        | 'service'
        | 'project'
        | 'deliverable'
        | 'task'
        | 'comment'
        | 'attachment'
        | 'metric'
        | 'notification';
      fee_model: 'RETAINER' | 'FIXED' | 'HOURLY' | 'PERFORMANCE';
      file_kind:
        | 'ATTACHMENT'
        | 'DELIVERABLE_ASSET'
        | 'REPORT_EXPORT'
        | 'BRAND_ASSET'
        | 'CONTRACT'
        | 'AVATAR'
        | 'OTHER';
      invitation_status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
      membership_status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
      metric_key:
        | 'PIPELINE_ENGINEERED'
        | 'BLENDED_ROAS'
        | 'P75_LCP_MS'
        | 'LTV_CAC_RATIO'
        | 'PAGES_INDEXED'
        | 'CAPI_MATCH_RATE'
        | 'LEAD_RESPONSE_MINUTES'
        | 'MQL_COUNT'
        | 'SQL_COUNT'
        | 'CPA'
        | 'CTR'
        | 'CONVERSION_RATE'
        | 'SESSIONS'
        | 'REVENUE';
      metric_source:
        | 'MANUAL'
        | 'GA4'
        | 'GOOGLE_ADS'
        | 'META_ADS'
        | 'SEARCH_CONSOLE'
        | 'CRM'
        | 'CRUX'
        | 'INTERNAL';
      metric_unit: 'CURRENCY' | 'COUNT' | 'RATIO' | 'PERCENT' | 'MILLISECONDS' | 'MINUTES';
      notification_severity: 'INFO' | 'WARNING' | 'CRITICAL';
      notification_type:
        | 'DELIVERABLE_SUBMITTED'
        | 'DELIVERABLE_APPROVED'
        | 'REVISION_REQUESTED'
        | 'REPORT_PUBLISHED'
        | 'TASK_ASSIGNED'
        | 'TASK_DUE_SOON'
        | 'COMMENT_ADDED'
        | 'MENTION'
        | 'INVITATION_SENT'
        | 'MEMBERSHIP_CHANGED'
        | 'SYSTEM';
      org_status: 'PROSPECT' | 'ONBOARDING' | 'ACTIVE' | 'PAUSED' | 'CHURNED' | 'ARCHIVED';
      organization_role: 'CLIENT_ADMIN' | 'CLIENT_MEMBER';
      platform_role: 'SUPER_ADMIN' | 'ADMIN';
      priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
      project_health: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK';
      project_member_role: 'LEAD' | 'CONTRIBUTOR' | 'REVIEWER' | 'OBSERVER';
      project_status:
        'PLANNED' | 'IN_PROGRESS' | 'BLOCKED' | 'IN_REVIEW' | 'COMPLETED' | 'CANCELLED';
      region_code: 'NYC' | 'LDN' | 'SYD' | 'DIFC';
      report_cadence: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'AD_HOC';
      report_status: 'DRAFT' | 'INTERNAL_REVIEW' | 'PUBLISHED' | 'ARCHIVED';
      report_type:
        'PERFORMANCE' | 'EXECUTIVE_SUMMARY' | 'CAMPAIGN' | 'SEO' | 'TECHNICAL_AUDIT' | 'QBR';
      review_outcome: 'APPROVED' | 'REVISION_REQUESTED' | 'REJECTED';
      scan_status: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
      service_line:
        | 'PROGRAMMATIC_SEO'
        | 'PRECISION_PAID_MEDIA'
        | 'WEB_CORE'
        | 'LIFECYCLE_CRM'
        | 'AI_AUTOMATIONS'
        | 'VIDEO_MULTIMEDIA'
        | 'ACCOUNT_MANAGEMENT';
      service_status: 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
      task_status: 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'IN_REVIEW' | 'DONE' | 'CANCELLED';
      team:
        | 'ACCOUNT_MANAGEMENT'
        | 'SEO'
        | 'PAID_MEDIA'
        | 'WEB_DEVELOPMENT'
        | 'CRM_LIFECYCLE'
        | 'AI_AUTOMATION'
        | 'VIDEO_MULTIMEDIA';
      user_type: 'INTERNAL' | 'CLIENT';
    };
    CompositeTypes: Record<string, never>;
  };
}

/** Row type of a public table: `Tables<'projects'>`. */
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

/** Insert type of a public table. */
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

/** Update type of a public table. */
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];

/** A public enum: `Enums<'deliverable_status'>`. */
export type Enums<T extends keyof Database['public']['Enums']> = Database['public']['Enums'][T];
