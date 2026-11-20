# Chemora Inventory: email setup (Resend)

Two things send email: Supabase Auth (password reset) and the `inventory-notify` edge function (order updates).
Both use the same Resend account and the same verified domain.

## 1. Resend (about 10 minutes)
1. Create an account at resend.com and open **Domains > Add Domain** > `chemora.art`.
2. Add the DNS records Resend shows (SPF, DKIM and the MX/return-path entries) at your DNS host, then press **Verify**.
3. **API Keys > Create API Key** (permission: *Sending access*, domain: `chemora.art`). Copy it once.

## 2. Password reset: Supabase Auth
Supabase dashboard > **Authentication**:
1. **SMTP Settings** > enable *Custom SMTP*:
   - Host `smtp.resend.com`, Port `465`, Username `resend`, Password = the Resend API key
   - Sender email `noreply@chemora.art`, Sender name `Chemora Inventory`
2. **URL Configuration**: Site URL `https://app.chemora.art`; add Redirect URL `https://app.chemora.art/**`
   (add `http://localhost:8766/**` too if you test locally).
3. Optional: **Email Templates > Reset Password** to change the wording.
4. Optional: **Rate Limits** to raise the default of 30 auth emails per hour.

## 3. Order emails
1. SQL editor: run `sql/10_order_notifications.sql` (recipient list table, save function, once-per-event log) and `sql/11_order_email_choice.sql` (the requester's email option).
2. Edge Functions > **Deploy a new function** named `inventory-notify`, paste `supabase/functions/inventory-notify/index.ts`.
   Use the same JWT setting as `inventory-users` (the function checks the sign-in token itself).
3. Edge Functions > **Secrets**: add `RESEND_API_KEY` (the key from step 1).
   Optional: `MAIL_FROM` (default `Chemora Inventory <noreply@chemora.art>`), `SITE_URL` (default `https://app.chemora.art/`).
4. In the app: **Order Requests > Current Orders > Order Settings**, enter the addresses, **Save**, then **Send Test Email to Me**.

## Who gets what
- Addresses in Order Settings (per lab): every order event (requested, placed, received, cancelled).
- A new request emails only the Order Settings addresses.
- The person who made the request: placed, received and cancelled, only if they ticked "Email me when this order is placed, received or cancelled" on the request form (not for their own actions).
- Each event is emailed once per order; a failed email never blocks the order itself.

## Welcome email when a lab administrator adds a user
- Add User has an optional password and a ticked box "Email a welcome message with the sign-in link".
- Leave the password empty (recommended): a random password nobody sees is set, and the welcome email tells the user to choose
  their own with "Forgot Password?". The administrator never handles a password.
- Adding an existing account from another lab sends a short "you have been added to this lab" email.
- Needs the `inventory-users` function to be redeployed (paste the new `supabase/functions/inventory-users/index.ts`) and the
  same `RESEND_API_KEY` secret. If the email cannot be sent, the user is still created and the page says so.
- "Forgot Password?" only works once the Supabase SMTP settings above are in place.
