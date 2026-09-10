# Privacy Disclosures

*Added in 4.16.0.*

A publicly reachable MeshMonitor re-serves mesh data — node names, positions, message
traffic — to anonymous visitors and to tokenless embed viewers. Privacy disclosures let
the operator state, in the interface itself, what policy applies to that data and who is
responsible for it.

Three documents are supported: **Privacy Policy**, **Terms of Service**, and **Contact**.
Each is optional and off by default; nothing is rendered until you configure one.

## Two ways to publish

Each of the three slots can be filled either way. If both are set for the same slot, the
hosted document wins.

### Link to a document you host elsewhere

Set a URL and MeshMonitor renders a link to it. Suitable when your policy already lives
on a club site or a company page.

| Setting | Purpose |
|---|---|
| `privacyPolicyUrl` | Link target for the Privacy Policy slot |
| `termsOfServiceUrl` | Link target for the Terms of Service slot |
| `contactUrl` | Link target for the Contact slot |

An empty string means no link is rendered for that slot.

### Host the document in MeshMonitor

Write the document in MeshMonitor and it is served at a stable public path:

```
/privacy      /terms      /contact
```

Bodies are authored in Markdown, including GitHub-flavoured tables and task lists, and
render on a standalone page that does not require a login. That matters: a visitor who
cannot see the dashboard still needs to be able to read the policy that covers the data
they were just shown.

A hosted document **takes precedence** over the matching URL setting, so you can stage a
replacement by writing it, and fall back by deleting it.

## Who can edit

Editing is admin-gated. The API separates the two concerns deliberately:

| Endpoint | Access |
|---|---|
| `GET /api/privacy/links` | Public — the resolved set of links to render |
| `GET /api/privacy/documents/:slug` | Public — one hosted document |
| `/api/privacy/admin/documents` | Admin — create, update, delete |

The public router is mounted at both the base URL and the site root, so disclosures stay
reachable when MeshMonitor is served under a sub-path such as `/meshmonitor`.

## Backup and restore

Hosted documents are included in system backups and restored with the rest of the
configuration, so a rebuilt instance comes back with its disclosures intact rather than
silently losing them.

## What this does not do

- It does not change what data MeshMonitor collects or serves. It is disclosure, not
  enforcement. See [Map Privacy and Security](/features/maps#map-privacy-and-security)
  for the controls that actually restrict what anonymous visitors can see.
- It does not write a policy for you. The documents are whatever you put in them.
- It is unrelated to `noIndexEnabled` (which asks crawlers not to index the dashboard)
  and to `linkPreviewsEnabled` (which controls outbound link-preview fetches), though
  operators exposing an instance publicly usually want to consider all three.
