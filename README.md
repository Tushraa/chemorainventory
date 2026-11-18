# Chemora | Chemical Inventory for Research Laboratories

**Developed in the Department of Organic Chemistry | Indian Institute of Science (IISc), Bengaluru, India**

🌐 **Official Website: (https://www.chemora.art/)**

---

## About Chemora

**Chemora** is a web-based chemical inventory and laboratory-management platform built for academic research groups. It keeps track of every chemical container in a laboratory: what it is, where it is stored, who owns it, how much is left and what its hazards are.

The interface follows the familiar layout of established laboratory inventory systems: a left-hand menu, a search panel, result tables and grids, and a location tree. It is designed for chemists who move containers between cabinets, fridges and rooms every day. Chemora supports several laboratories on one platform, and the data of one lab is never visible to another.

## Key Features

### 1. Search and Discovery

- Search by name or synonym, CAS number or barcode, and limit the search to a location.
- **Structure search** (exact, substructure and similarity) with a built-in JSME structure editor.
- **Advanced search** with combinable rules (supplier, purity, dates, owner and more).
- **GHS hazard search** by H-statements, with a hazard summary on every container.
- Table and grid views, selectable columns, bulk select, and CSV download of results.

### 2. Containers and Locations

- Add containers in two steps, with optional pre-printed barcodes and "no CAS number" support.
- Hierarchical locations (building, room, cabinet, shelf) with a browsable location tree.
- Move, transfer, update quantity, duplicate or delete containers, singly or in bulk.
- Per-container history and **My Collection** for the containers you own.

### 3. Scanning, Labels and Audits

- **Scan to Move**: scan container barcodes and a destination location to relocate containers.
- Printable barcode labels and an **Assigned Barcodes** register (barcodes are never reused).
- **Stocktake & Audit**: pick a location, scan what you find, and get a report of missing, unexpected and unknown containers.

### 4. Orders, Imports and Exports

- Request an order, track current orders, and download pending orders.
- Import inventories from CSV, export the full inventory, and use **Bulk Container Update** to edit many containers from a spreadsheet with a preview before anything is saved.

### 5. Administration and Auditing

- **Activity History & Auditing** with readable events ("Ethanol (HG-000001) moved to Room 1"), filters by user, subject and date, and CSV export.
- Three account types: **Member**, **Chemical Manager** and **Administrator**.
- **Lab administrators** control only their own lab's inventory and users.
- The **Inventory Administrator** (platform administrator) controls every lab and every user: creating and deactivating labs, appointing lab administrators, and managing accounts from the *Labs & All Users* page.

## Sponsors

The left menu, below the signed-in user and laboratory information, carries three sponsor slots from top to bottom:

| Slot | Logo file |
|---|---|
| Building Block Sponsor | `sponsors/building-block.png` |
| Catalyst Sponsor | `sponsors/catalyst.png` |
| Solvent Sponsor | `sponsors/solvent.png` |

Add the sponsor's logo with the file name above and it appears automatically. See [`sponsors/README.md`](sponsors/README.md) for details.

---

## Repository Overview

| File / Folder | Description |
|---|---|
| `inventory.html` | Application page and all views |
| `inventory.js` | Application logic |
| `inventory.css`, `chemora-theme.css` | Base styles and the Chemora interface theme |
| `config.js` | Supabase connection settings (public publishable key) |
| `sql/` | Database scripts, run in order in the Supabase SQL Editor |
| `supabase/functions/inventory-users/` | Edge function for account management |
| `jsme/` | JSME structure editor files (see `JSME_SETUP.md`) |
| `sponsors/` | Sponsor logos shown in the menu |

## Technologies

Chemora is developed using:

- HTML5, CSS3 and JavaScript
- Supabase (PostgreSQL with row-level security, authentication and Edge Functions)
- JSME molecular editor and PubChem structure images
- Font Awesome icons
- Responsive layouts for desktop, tablet and mobile

## Setup and Database Upgrades

1. Create a Supabase project and enter its URL and publishable key in `config.js`.
2. Run the scripts in `sql/` in order (`01` to `05`) in the Supabase SQL Editor. Every script is safe to run more than once.
   - `sql/04_activity_descriptions.sql` adds readable descriptions to the activity log.
   - `sql/05_platform_admin.sql` adds the **Inventory Administrator** role, the Labs & All Users page, GHS hazard codes, pre-printed barcodes and bulk container actions.
3. Deploy the `inventory-users` edge function from `supabase/functions/inventory-users/`.
4. Copy the JSME files into `jsme/` as described in `JSME_SETUP.md`.
5. Open `inventory.html` through a web address.

## Contact

**Hari Group**  
Department of Organic Chemistry  
Indian Institute of Science (IISc)  
Bengaluru 560012, India

**Website:** (https://www.chemora.art/)

---

© 2026 Chemora, Hari Group, Indian Institute of Science, Bengaluru. All rights reserved.
