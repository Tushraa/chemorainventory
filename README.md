# Chemora inventory
Open `inventory.html`. Database: Supabase (see `sql/`). Structure editor: JSME in `jsme/` (see JSME_SETUP.md).

## Menu and activity history (database upgrade)

Run `sql/04_activity_descriptions.sql` once in the Supabase SQL Editor (after the earlier scripts). It adds readable descriptions to the activity log (for example "Ethanol (HG-000001) moved to Room 1"). Until it is run, Activity History & Auditing still works and shows generated descriptions for new rows.
