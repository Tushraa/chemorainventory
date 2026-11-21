# Sponsor logos

The Chemora menu shows a sponsor panel ("Our Sponsors") with three slots, from top to bottom. Each slot has a resting logo and,
optionally, a real-colour logo that appears on hover. Add files with exactly these names and they appear automatically;
until then the slot shows "Your logo here".

| Slot | Resting logo (light grey PNG, transparent) | Hover logo (real colours, SVG or transparent PNG) |
|---|---|---|
| Building Block | `building-block.png` | `building-block-color.svg` |
| Catalyst | `catalyst.png` | `catalyst-color.svg` |
| Solvent | `solvent.png` | none yet (the grey logo stays on hover) |

The hover logo must have the same proportions as the resting logo so the slot does not jump. To add a hover logo for a slot,
add an `<img class="sp-color" ...>` after the `sp-grey` image of that slot in `inventory.html` (both `ci-sponsors` blocks).
To link a logo to the sponsor's website, edit the `href` of that slot (search for `ci-sponsors`).
