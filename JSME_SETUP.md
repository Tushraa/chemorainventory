# Adding the JSME structure editor

Chemora's Structure Search window loads the free JSME editor (BSD licence) from a `jsme` folder next to
`inventory.html`. JSME is plain static files (about 1-2 MB), so it needs no Supabase space and fits
GitHub's web upload limit.

## 1. Download JSME
Get the release from the JSME website: https://jsme-editor.github.io (Download section).
I could not open that site from my workspace, so check the page for the current download.
You need the browser (JavaScript) version, which contains `jsme.nocache.js` and a few other files.

## 2. Place the files
```
your-website/
  inventory.html
  inventory.js
  jsme/
    jsme.nocache.js      <-- this exact path is what Chemora loads
    (all other JSME files and folders from the download)
```
If the download comes as a folder with another name, rename it to `jsme`.

## 3. Open the site through a web address
Use https://... (GitHub Pages, Netlify, your university server) or http://localhost while testing.
Opening `inventory.html` straight from disk (file://) will not load the editor.

## 4. Test
Sign in, open Search Chemicals, click Structure Search, draw benzene, click Exact Match Search.
Chemora asks PubChem which compound it is, takes its CAS numbers and lists matching containers.

If the editor is missing, the window shows a notice and you can still paste a SMILES string
(for example `CCO` for ethanol) into the field below the editor.

## What each button does
| Button | Status |
| --- | --- |
| Exact Match Search | Works. Finds the same compound by CAS number (or name when PubChem has no CAS). |
| Substructure & Similarity Search | Built in. The RDKit engine runs in the browser (loaded from a CDN); structures are looked up once from PubChem and stored per chemical (run `sql/06_structure_search.sql`). |
| Similarity Search | Not available. Same requirement. |

## Privacy
Exact Match sends only the drawn structure (its SMILES) to PubChem. No inventory data is sent.
