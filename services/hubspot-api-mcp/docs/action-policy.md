# Action policy

The service enforces this policy. A tool argument, prompt, or `approved=true` flag cannot change it.

Default for this release, from `HUBSPOT_ACTION_POLICY=read-only` and `HUBSPOT_EXPORT_CREATION=deny`:

| Action | Status |
| --- | --- |
| Reads | Allowed when the stored HubSpot grant includes the operation's scopes. |
| Writes | Denied. Set `HUBSPOT_ACTION_POLICY=writes-with-approval` to require the human approval page for non-delete changes. |
| Export creation | Denied. Set `HUBSPOT_EXPORT_CREATION=approval` to require the same human approval. A read-only policy does not create exports. |
| Export retrieval | Allowed as a read when the grant allows it. Off-host download links in the response are withheld. Requests stay on the configured HubSpot API host, and redirects are not followed. |
| Delete, archive, and purge | Denied for this release. The operation register still lists them. `files.delete`, `commerce.payment_links.delete`, and `business_units_view.read` stay excluded as well. |

There is no environment setting that turns deletion on. That stays unresolved until an explicit later policy.

`hubspot_capabilities` reports the effective policy, the stored grant, and separate counts for allowed reads, approval-required operations, and policy denials. A missing grant is reported as not connected. The service does not invent scopes.

Properties are passed through when the grant and the endpoint accept them. The short static property classifier has been removed.
