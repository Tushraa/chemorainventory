# Chemora inventory
Open `inventory.html`. Database: Supabase (see `sql/`). Structure editor: JSME in `jsme/` (see JSME_SETUP.md).

## Menu and activity history (database upgrade)

Run `sql/04_activity_descriptions.sql` once in the Supabase SQL Editor (after the earlier scripts). It adds readable descriptions to the activity log (for example "Ethanol (HG-000001) moved to Room 1"). Until it is run, Activity History & Auditing still works and shows generated descriptions for new rows.

Then run `sql/05_platform_admin.sql` once and redeploy the `inventory-users` edge function. This makes `tushraas@iisc.ac.in` the **Inventory Administrator**: an administrator of every lab (open any lab, create or deactivate labs, see and manage all users on the "Labs & All Users" page). Each lab's own administrators control only their lab's inventory and users. The script also adds GHS hazard codes, pre-printed barcodes and bulk container actions.
