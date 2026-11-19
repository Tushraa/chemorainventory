<div align="center">

<a href="https://www.chemora.art/">
  <img src="chemora_logo.svg" alt="Chemora logo" width="260">
</a>

<h1>Chemora</h1>

<h3>Chemical Inventory for Research Laboratories, Hari Group, Indian Institute of Science (IISc), Bengaluru</h3>

[![Website](https://img.shields.io/badge/website-www.chemora.art-263A67)](https://www.chemora.art/)
[![Backend](https://img.shields.io/badge/backend-Supabase-3ecf8e)](https://supabase.com/)
[![Built with](https://img.shields.io/badge/built%20with-HTML%20%7C%20CSS%20%7C%20JS-e34c26)](#technologies)
[![Last commit](https://img.shields.io/github/last-commit/Tushraa/chemorainventory?color=facc15)](https://github.com/Tushraa/chemorainventory/commits/main)

</div>

Source code of **Chemora**, the web-based chemical inventory of the **Hari Group** (Principal Investigator: **Dr. Durga Prasad Hari**), Department of Organic Chemistry, IISc Bengaluru. Chemora keeps track of every chemical container in a laboratory: what it is, where it is stored, who owns it, how much is left and what its hazards are. It supports several laboratories on one platform, and the data of one lab is never visible to another.

## Live Website

**https://www.chemora.art/**

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
| Building Block Sponsor | `sponsors/building-block.png` |
| Catalyst Sponsor | `sponsors/catalyst.png` |
| Solvent Sponsor | `sponsors/solvent.png` |

Add a logo with the file name above and it appears automatically (see [`sponsors/README.md`](sponsors/README.md)).

## Project Structure

```
chemorainventory/
├── inventory.html      application page and all views
├── inventory.js        application logic
├── inventory.css       base styles
├── chemora-theme.css   Chemora interface theme
├── config.js           Supabase connection (public publishable key)
├── sql/                database scripts 01 to 06, run in order
├── supabase/functions/inventory-users/   account-management edge function
├── jsme/               JSME structure editor (see JSME_SETUP.md)
└── sponsors/           sponsor logos shown in the menu
```

## Technologies

- HTML5, CSS3 and vanilla JavaScript
- Supabase: PostgreSQL with row-level security, authentication and Edge Functions
- JSME molecular editor and PubChem structure images
- Font Awesome icons
- Responsive layout for desktop, tablet and mobile

## Setup

1. Create a Supabase project and enter its URL and publishable key in `config.js`.
2. Run the scripts in `sql/` in order (`01` to `06`) in the Supabase SQL Editor. Each is safe to run more than once.
   - `04_activity_descriptions.sql` adds readable descriptions to the activity log.
   - `05_platform_admin.sql` adds the Inventory Administrator role, the Labs & All Users page, GHS hazard codes, pre-printed barcodes and bulk container actions.
   - `06_structure_search.sql` stores each chemical's structure (SMILES) for substructure and similarity search.
3. Deploy the `inventory-users` edge function from `supabase/functions/inventory-users/`.
4. Copy the JSME files into `jsme/` as described in `JSME_SETUP.md`.
5. Open `inventory.html` through a web address.

## Contact

**Hari Group**, Department of Organic Chemistry, Indian Institute of Science, Bengaluru 560012, India

For collaborations and enquiries, see the [Hari Group website](https://harigroup.orgchem.iisc.ac.in/).

---

<div align="center">

© 2026 Chemora, Hari Group, Indian Institute of Science, Bengaluru. All rights reserved.

</div>
