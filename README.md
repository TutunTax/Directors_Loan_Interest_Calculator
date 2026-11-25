# Director & related-party loan interest (multi-client)

Static web app (GitHub Pages) + Supabase (Postgres, Auth, row-level security).
Each client is a tenant; staff only see the clients they are added to; you (platform admin) see all.
Sage ledgers are read in the browser and never stored. Only settings, rates and a journal history are saved.

## 1. Supabase
1. Create a project at supabase.com.
2. **Authentication → Providers → Email**: keep enabled; turn **off** "Allow new users to sign up".
3. **Authentication → Users → Add user**: create yourself (email + password, tick auto-confirm). Do the same (or "Invite user") for each staff member.
4. **SQL Editor**: run `sql/01_schema.sql`.
5. Open `sql/02_seed_pmm.sql`, set `v_email` to your login email, run it. This creates you as platform admin, the prime history, the client PMM and its three loan accounts with their rate rules.
6. **Project Settings → API**: copy the Project URL and the `anon` public key.

## 2. Configure
Edit `js/config.js` and paste the URL and anon key. (The anon key is public by design; the row-level security policies protect the data.)

## 3. GitHub Pages
1. Create a GitHub repo and push these files (index.html, js/, sql/, README.md) to `main`.
2. Repo **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Open the Pages URL, sign in.
4. In Supabase **Authentication → URL Configuration**, set Site URL to the Pages URL.

## Using it
- Pick the client at the top. Load the Sage "Account Transactions Report" files, review, enter the Sage ledger accounts once, download the journal CSV, post in Sage, download PDF statements.
- **Roles per client:** admin (settings + people), staff (run + edit settings), viewer (read only).
- **Prime rate** is shared by all clients and only platform admins can change it.
- **New client:** "+ New client" (platform admins only), then Rates & settings → People to give staff access. Staff must already exist as users.
- New loan accounts are added automatically the first time their ledger is loaded; enter their rate when prompted.
