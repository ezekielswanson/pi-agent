# Apartment Life business charter

This note is separate from the technical implementation. Broad HubSpot API access does not decide which record should change.

Apartment Life's operating rule is to confirm writes and keep field updates small. A mutation still needs a known record, a proposed change, and a person who approves that exact proposal. If the record, the process rule, or the expected outcome is ambiguous, stop and ask before preparing a change.

Portal `5627913` is the only portal this service is built to use. A signed-in browser session, when one is needed to read account eligibility, is inspection only. It is not approval to create an app, change the existing MCP connector, or edit CRM records.

Payment-link deletion, file deletion, and `business_units_view.read` stay unavailable. Billing changes, user removal, publishing, sending, merging, and imports stay behind the same human approval step as other mutations.
