# Integration Plan: `admin.html` and Super Admin / Staff Access Control

## Overview
Integrate the existing `admin.html` into the current coaching center management system while preserving all existing SQLite databases, CRUD logic, dashboard layouts for staff/super admins, and existing permissions (including super admin DELETE permissions and staff DELETE restrictions).

---

## Key Steps & Architecture

### 1. Navigation & Access Point for Super Admin
- Add an "Admin Panel" or "Staff Applications" link/button in the existing navigation or dashboard sidebar **only** when the logged-in user is a `super_admin`.
- Ensure `admin.html` uses the existing navigation/styling header components or matches the design system.

### 2. Backend Security & Endpoint Protection
- Ensure `backend/staffAdmin.js` and `backend/api.js` use robust authentication checking `user_roles` (`super_admin` vs `staff`).
- All admin endpoints (`/api/admin/staff-applications`, etc.) require `requireSuperAdmin` middleware which returns HTTP `403` for staff and HTTP `401` for unauthenticated/unauthorized users.

### 3. Frontend Role Guard & Session Verification
- `frontend/admin.html` performs client-side verification via `window.authReady` / `window.auth.getSession()` and checks `role === 'super_admin'`. If not `super_admin`, redirect to `/dashboard.html`.
- Staff users attempting to access `/admin.html` directly will be instantly redirected back to `/dashboard.html`, and any API calls will return `403 Forbidden`.

### 4. Preservation of Existing Features
- SQLite database and tables remain untouched.
- Existing Supabase authentication and session persistence remain unchanged.
- Staff dashboard and regular CRUD operations remain unaffected.
