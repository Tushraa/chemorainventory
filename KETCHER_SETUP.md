# Adding the Ketcher structure editor

Chemora's Structure Search window already contains the Ketcher editor frame. It only needs the Ketcher
files placed on your website. Ketcher is plain static files, so it uses no Supabase storage or database space.

## 1. Get a built copy of Ketcher

You need the ready-to-run **standalone build** (a folder containing `index.html`, JavaScript and WASM files).

- Download the standalone build from the Ketcher releases page: https://github.com/epam/ketcher/releases
  (I could not open GitHub from my workspace, so please check which file on that page is the standalone build).
- Or build it yourself from the source repository by following its README.
- Do **not** use the `ketcher-standalone` package from npm. It is a library for React projects, not a ready-built page.

## 2. Place the files next to `inventory.html`

```
your-website/
  inventory.html
  inventory.js
  inventory.css
  ketcher/
    index.html        <-- this exact path is what Chemora loads
    (all other Ketcher files and folders)
```

## 3. Serve the site over a web address

Open the site through `https://...` (GitHub Pages, Netlify, Cloudflare Pages, your university server) or
`http://localhost` while testing. Opening `inventory.html` straight from disk (`file://`) will not work:
the editor loads WebAssembly files, and the page must read the editor's drawing, which browsers only allow
when both are on the same site.

## 4. Test it

1. Sign in, open **Search Chemicals**, click **Structure Search**.
2. The editor loads inside the window. Draw a molecule, for example benzene.
3. Click **Exact Match Search**. Chemora asks PubChem which compound it is, takes its CAS numbers, and lists
   matching containers in your inventory.

If the editor is missing, the window shows a notice instead and you can still paste a SMILES string
(for example `CCO` for ethanol) into the field below the editor. Pasting a SMILES also draws it in the editor
once Ketcher is installed.

## What each button does

| Button | Status |
| --- | --- |
| Exact Match Search | Works. Finds the same compound in your inventory by CAS number (or name if PubChem has no CAS). |
| Substructure Search | Not available yet. Needs your structures stored as SMILES plus an RDKit search service. |
| Similarity Search | Not available yet. Same requirement. |

## Privacy

Exact Match sends only the drawn structure (its SMILES) to PubChem. No inventory data, names of
your lab, or user details are sent.

## Troubleshooting

- **"The Ketcher editor was not found"**: the file `ketcher/index.html` is not at that path on the site, or the page
  was opened from disk instead of a web address.
- **"Ketcher did not finish loading"**: slow connection or a blocked file. Open `ketcher/index.html` directly in the
  browser to confirm it loads, then reopen the Structure Search window.
- **"PubChem could not identify this structure"**: the drawing may use R-groups, query atoms or a very new compound.
  PubChem needs a normal, fully specified structure.
