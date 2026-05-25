/*
  # Email Verification System

  ## Summary
  Sets up the full email verification infrastructure for Apocrita.

  ## New Tables

  ### `profiles`
  Stores user account state keyed on Supabase auth.uid().
  - `id` (uuid, PK) — matches auth.users.id
  - `email` (text, unique) — user email address
  - `email_verified` (boolean) — true once the user clicks their verification link
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `verification_tokens`
  One-time tokens emailed to users after signup.
  - `id` (uuid, PK)
  - `email` (text, indexed) — the address being verified
  - `token` (text, unique, indexed) — cryptographically random hex string (48 chars)
  - `used` (boolean) — marked true once consumed to prevent replay
  - `expires_at` (timestamptz) — 24 hours after creation
  - `created_at` (timestamptz)

  ## Security
  - RLS enabled on both tables
  - Tokens readable only by service role (backend) — no anon/user read access
  - Profiles readable/updatable only by the owning user
  - Service role insert allowed for both tables (server-side API handlers)

  ## Notes
  1. Tokens expire after 24 hours
  2. `used` flag prevents replay attacks
  3. Only one active token per email at a time (enforced by DELETE before INSERT in API)
*/

-- ===== PROFILES =====

CREATE TABLE IF NOT EXISTS profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text UNIQUE NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Service role can insert profiles"
  ON profiles FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update profiles"
  ON profiles FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ===== VERIFICATION TOKENS =====

CREATE TABLE IF NOT EXISTS verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  token      text UNIQUE NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verification_tokens_email_idx ON verification_tokens(email);
CREATE INDEX IF NOT EXISTS verification_tokens_token_idx ON verification_tokens(token);

ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;

-- Only service_role (server-side API) can read/write tokens — never the browser client
CREATE POLICY "Service role can insert tokens"
  ON verification_tokens FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can select tokens"
  ON verification_tokens FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role can update tokens"
  ON verification_tokens FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can delete tokens"
  ON verification_tokens FOR DELETE
  TO service_role
  USING (true);
