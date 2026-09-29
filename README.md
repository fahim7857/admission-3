# Coaching Center Management System

Web-based coaching center management with the existing SQLite application database,
Supabase Auth for persistent sign-in, and Supabase roles for backend authorization.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set the Supabase values.
3. Run `npm run dev`.

The first Super Admin account is created in Supabase Auth. Assign its role by
running the commented initial-admin statement in `supabase/setup.sql`.

SQLite remains the application database. Supabase is used only for Auth, roles,
and staff application review.