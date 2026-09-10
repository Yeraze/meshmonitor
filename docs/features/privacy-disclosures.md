# Privacy Disclosures

*Added in 4.16.0.*

Publish your privacy policy, terms of service, and contact details in MeshMonitor.

You need this if strangers can reach your dashboard. A public MeshMonitor hands mesh data —
node names, positions, message traffic — to anyone who opens it, including people viewing an
embedded map. These three documents tell them what happens to that data and who to ask about it.

All three are optional and start empty. Nothing shows up until you set one.

## Two ways to publish

Fill each slot either way. If you do both, the hosted document wins.

### Link to a document you host elsewhere

Set a URL and MeshMonitor links to it. Use this when your policy already lives on a club site
or a company page.

| Setting | Fills |
|---|---|
| `privacyPolicyUrl` | Privacy Policy |
| `termsOfServiceUrl` | Terms of Service |
| `contactUrl` | Contact |

Leave a setting empty and MeshMonitor shows no link for it.

### Host the document in MeshMonitor

Write the document in MeshMonitor and it serves it at a fixed path:

```
/privacy      /terms      /contact
```

Write the body in Markdown, including tables and task lists. The page needs no login — which is
the point, since a visitor who cannot see your dashboard must still be able to read the policy
that covers what you just showed them.

A hosted document beats the matching URL setting. So you can stage a replacement by writing it,
and fall back by deleting it.

## Who can edit

Only admins. The API splits the two jobs on purpose:

| Endpoint | Who |
|---|---|
| `GET /api/privacy/links` | Anyone — the links to show |
| `GET /api/privacy/documents/:slug` | Anyone — one hosted document |
| `/api/privacy/admin/documents` | Admins — create, update, delete |

MeshMonitor mounts the public routes at both the base URL and the site root, so your
disclosures stay reachable when you serve the app under a sub-path such as `/meshmonitor`.

## Backup and restore

System backups include hosted documents. A rebuilt instance comes back with its disclosures
intact instead of quietly losing them.

## What this does not do

- **It does not change what MeshMonitor serves.** This is disclosure, not enforcement. To
  restrict what anonymous visitors see, use the controls in
  [Map Privacy and Security](/features/maps#map-privacy-and-security).
- **It does not write your policy.** The documents say whatever you put in them.
- **It is not `noIndexEnabled` or `linkPreviewsEnabled`.** Those ask crawlers to skip your
  dashboard and control outbound link previews. If you run a public instance, weigh all three.
