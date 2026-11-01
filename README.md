# VERSIONPASS

A local-first delivery desk for creative work: identify an exact file revision,
bind it to an assigned reviewer, and check delivery and approval commitments on
Solana devnet. Original files stay in the browser.

This is an early prototype for the Encode Solana Hackathon. The mid-submission
checkpoint was successfully saved on 2 November 2026 (Asia/Taipei). That checkpoint
is not the final submission. A public deployment, demo video and verified live
devnet delivery-and-approval demonstration are not yet complete.

## Run locally

Requires Node.js 20.18 or newer. Install the pinned dependencies from the lockfile
with `npm ci`, then run:

```sh
npm run build
npm test
npm run dev
```

Open `http://127.0.0.1:31937/`. The development server binds only to loopback.
`dist/` is the static application; no backend, database, account, API key or paid
service is required. Language controls support English, Traditional Chinese and
Japanese. Explanations live on `about.html`, outside the main application.

The build also checks full dependency-license material. It stops if files or
upstream license metadata remain unresolved, preserving the existing bundle.
The current browser bundle has complete license material for all 26 reachable
packages, with no missing license files or metadata conflicts. Inspect
`dist/licenses/index.json` for the exact coverage, hashes and source evidence
before distributing a build. This build check does not prove a live transaction
or a completed hackathon submission.

## Judge walkthrough: no blockchain transaction required

1. Open the application and choose **Explore a sample**. Two synthetic storyboard
   revisions appear; revision 2 is selected initially. Both remain explicitly
   off-chain, and the recording and approval buttons are disabled.
2. Choose **Download this sample original** to save the selected revision as
   `versionpass-sample-v2.txt`. Choose **Export receipt** to save its receipt JSON.
   Selecting revision 1 changes the downloadable original to that revision.
3. Open **Verify a receipt**, choose **Choose receipt JSON**, and select the
   exported receipt. A valid structure is not blockchain verification.
4. Choose **Choose original file** and select the downloaded matching revision.
   The application computes SHA-256 locally and reports that the contents match.
   Compare a different revision or an edited copy to see a content mismatch.
5. Choose **Check live receipt**. The synthetic receipt has no transaction
   anchors, so it remains unverified. This step cannot establish delivery or
   approval on devnet. No test identities, faucet request or wallet are needed
   for this sample walkthrough.

The sample download uses only the synthetic bytes already generated in browser
memory. It does not upload a chosen file or create a transaction. The download
control is available only in sample mode; adding a local delivery leaves that
mode. English, Traditional Chinese and Japanese controls support this walkthrough.

For a future live demonstration, use **Devnet test session** to create temporary
test identities, then obtain free test credits through a supported route. Only
after funding is confirmed, add a synthetic file as a new delivery, record it,
wait for successful finalization, and approve that exact version. Export its
receipt and recheck it separately. Unavailable funding, a pending transaction or
a failed check must remain unverified. This live path has not yet been completed;
the local walkthrough and deterministic checks do not substitute for it.

## What the prototype checks

- A SHA-256 fingerprint identifies the selected file's bytes (maximum 64 MiB).
- A version commitment binds the file digest and size, preceding version,
  creator address and assigned reviewer address. An approval is a separate
  commitment to the exact version and the assigned reviewer's decision.
- The official Memo program records a commitment on devnet. File bytes, original
  filenames, notes and signing keys are not included in the Memo.
- A live check queries the official devnet RPC, then requires a finalized,
  successful transaction with the matching signature, signer, slot and Memo.
  Imported receipt claims are never accepted as live verification by themselves.

The sample workspace is synthetic and has no blockchain transactions. A missing,
pending or failed transaction must remain unverified. Network time and a client
timestamp are different evidence and must not be presented as interchangeable.

## Limits and privacy

The test creator and reviewer are separate temporary keypairs in one browser,
not two independently verified people. Keys exist in memory only and disappear
on refresh. Do not send real funds or use a real wallet. The app is devnet-only;
it has no mainnet, payment, identity-verification, durable-key recovery or legal
signature function. Public devnet infrastructure and its free faucet can be
rate-limited or reset; availability is not guaranteed.

Use synthetic files for demonstrations. Public commitments and addresses can
still be linkable. Receipt exports intentionally contain public records rather
than original files, local labels, notes or secrets. Google Fonts makes ordinary
font requests; the app contains no analytics integration. Local development
artifacts, credentials and private receipts must stay out of any published repo.

## Layout

- `dist/lib/core.mjs`: canonical records, file hashing and evidence validation.
- `dist/lib/solana.mjs`: devnet-only SDK adapter and transaction handling.
- `dist/lib/receipt-ui.mjs`: receipt import and presentation boundary.
- `dist/app.mjs`, `dist/index.html`, `dist/styles.css`: application interface.
- `src/solana-vendor.mjs`, `scripts/build.mjs`: locally bundled SDK dependencies.
- `tests/`: deterministic checks; these do not prove a live network transaction.

Builds collect full third-party license files and retain legal notices.
See `dist/licenses/index.json`, `THIRD_PARTY_NOTICES.md` and `LICENSE`.
Application source and the illustrative cover are original;
external packages and fonts retain their respective licenses.
