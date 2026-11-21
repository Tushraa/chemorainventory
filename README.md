<div align="center">

<a href="https://www.chemora.art/">
  <img src="logos/chemora_logo.svg" alt="Chemora logo" width="260">
</a>

<h1>Chemora Inventory</h1>

<h3>Chemical Inventory for Research Laboratories</h3>

[![App](https://img.shields.io/badge/app-app.chemora.art-12a58a)](https://app.chemora.art/)
[![Developed by](https://img.shields.io/badge/developed%20by-Chemora%20Art-263A67)](https://www.chemora.art/)
[![Backend](https://img.shields.io/badge/backend-Supabase-3ecf8e)](https://supabase.com/)
[![Built with](https://img.shields.io/badge/built%20with-HTML%20%7C%20CSS%20%7C%20JS-e34c26)](#technologies)
[![Last commit](https://img.shields.io/github/last-commit/Tushraa/chemorainventory?color=facc15)](https://github.com/Tushraa/chemorainventory/commits/main)

</div>

Source code of **Chemora Inventory**, a web-based chemical inventory for research laboratories, developed by [**Chemora Art**](https://www.chemora.art/), a software company that builds tools for research labs. Chemora Inventory keeps track of every chemical container in a laboratory: what it is, where it is stored, who owns it, how much is left and what its hazards are. It supports several laboratories on one platform, and the data of one lab is never visible to another. It is free of cost for every laboratory.

## Live App

**https://app.chemora.art/**

More about the company and its other tools: **https://www.chemora.art/**

## Features

- **Search:** by name or synonym, CAS number or barcode; structure search (exact, substructure, similarity) with a built-in JSME editor; advanced rule-based search; GHS hazard search.
- **Containers and locations:** two-step add form with optional pre-printed barcodes, hierarchical location tree, move, transfer, update quantity, duplicate or delete containers singly or in bulk, per-container history, and My Collection.
- **Scanning and audits:** Scan to Move, printable barcode labels, Assigned Barcodes register, and Stocktake & Audit with a missing / unexpected / unknown report.
- **Orders, import and export:** order requests and current orders, CSV import and export, and Bulk Container Update from a spreadsheet with a preview before saving.
- **Administration:** Activity History & Auditing with filters and CSV export, and three account types (Member, Chemical Manager, Administrator).
- **Multi-lab control:** lab administrators control only their own lab. The **Inventory Administrator** controls every lab and every user from the *Labs & All Users* page.

## Sponsors

Three sponsor slots appear in the left menu, below the signed-in user and laboratory information, from top to bottom:

| Slot | Logo file |
|---|---|
| Building Block Sponsor | `logos/sponsors/building-block.png` |
| Catalyst Sponsor | `logos/sponsors/catalyst.png` |
| Solvent Sponsor | `logos/sponsors/solvent.png` |

Add a logo with the file name above and it appears automatically (see [`logos/sponsors/README.md`](logos/sponsors/README.md)).

## Project Structure

```
chemorainventory/
├── inventory.html      application page and all views
├── inventory.js        application logic
├── inventory.css       base styles
├── chemora-theme.css   Chemora interface theme
├── config.js           Supabase connection (public publishable key)
├── logos/              logos and icons: site icon (same as www.chemora.art), Chemora logo, sponsors/
├── favicon.ico         site icon for browsers that ask for it at the root
├── email-logo.png      logo used in e-mails (linked by URL, so it stays at the root)
├── sql/                database scripts 01 to 16, run in order
├── supabase/
│   ├── functions/inventory-users/    account-management edge function (welcome email)
│   ├── functions/inventory-notify/   order email edge function
│   └── email-templates/              sign-in email templates (paste into Supabase)
├── EMAIL_SETUP.md      email setup (Resend + Supabase)
└── jsme/               JSME structure editor (see JSME_SETUP.md)
```

## Technologies

- HTML5, CSS3 and vanilla JavaScript
- Supabase: PostgreSQL with row-level security, authentication and Edge Functions
- JSME molecular editor and PubChem structure images
- Font Awesome icons
- Responsive layout for desktop, tablet and mobile

## Setup

1. Create a Supabase project and enter its URL and publishable key in `config.js`.
2. Run the scripts in `sql/` in order (`01` to `12`) in the Supabase SQL Editor. Each is safe to run more than once.
   - `04_activity_descriptions.sql` adds readable descriptions to the activity log.
   - `05_platform_admin.sql` adds the Inventory Administrator role, the Labs & All Users page, GHS hazard codes, pre-printed barcodes and bulk container actions.
   - `06_structure_search.sql` stores each chemical's structure (SMILES) for substructure and similarity search.
   - `10_order_notifications.sql` to `12_order_edit_and_cancel_rules.sql` add order emails and the order edit and cancel rules.
3. Deploy the `inventory-users` and `inventory-notify` edge functions from `supabase/functions/`, and set up email as described in `EMAIL_SETUP.md`.
4. Copy the JSME files into `jsme/` as described in `JSME_SETUP.md`.
5. Open `inventory.html` through a web address.

## Developed By

**[Chemora Art](https://www.chemora.art/)** builds software and tools for research laboratories: chemical inventory, invoice management, analysis tools and laboratory websites. Source of the company website: [Tushraa/chemora](https://github.com/Tushraa/chemora).

## Contact

For questions, demos and custom tools, write to **[booking@chemora.art](mailto:booking@chemora.art)**.

---

<div align="center">

© 2026 Chemora Art. All rights reserved.

</div>
