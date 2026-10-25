-- Contacts an AI app adds or changes (K2, 2026-10-25 18:05: contact_add, contact_update, contact_remove). Additive.
--   contacts.added_by: the AI app's name, shown on the Contacts page ("added by Claude"); NULL for the owner's own.
--   contacts.added_by_connection: that app's connection id.
--   contact_destinations.source: who put the address there: ai (an AI app), claim_link (the person chose it on a
--   claim link), or NULL (the owner, or rows written before 0010). The first payment to an address an AI app saved
--   takes the owner lane whatever the amount, unless the address is already known (paid before, chosen on one of the
--   wallet's claim links, or a payment request the wallet paid).
ALTER TABLE contacts ADD COLUMN added_by TEXT;
ALTER TABLE contacts ADD COLUMN added_by_connection TEXT;
ALTER TABLE contact_destinations ADD COLUMN source TEXT;
