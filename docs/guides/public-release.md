# Public-release checklist (git history included)

The working tree is covered by `scripts/check-public-boundary.mjs`. History is
separate: old commits still contain the pre-sanitization paths, usernames, and
the design screenshots that were removed from the current tree. Before making
the repository public, either rewrite history or rebuild the repository from a
clean squash commit.

## 1. Freeze and back up

- Announce a short freeze; no one pushes during the rewrite.
- Keep a private mirror, not just a working copy:

```bash
git clone --mirror git@github.com:kakaCat/dsh-record-and-replay.git \
  ../dsh-record-and-replay.git.backup
```

- Record the current head/tags (`git rev-parse HEAD`, `git tag -l`) so the
  rewrite can be compared.

## 2. Inspect the current history

```bash
PUBLIC_BOUNDARY_ACCOUNT=<your-account> node scripts/check-git-history.mjs
```

It scans every reachable commit for `/Users/<real name>`, external volume
paths, the account name, private-key headers, and API-key shapes. A non-zero
exit is expected on the current history; the rewrite below is what clears it.

## 3. Prepare replacements

Create `replacements.txt` **outside** the repository:

```text
/Users/<your-account>==>/Users/<user>
/Volumes/<your-volume>/<your-workspace>==><workspace>
/Volumes/<your-volume>==>/Volumes/<volume>
<your-hostname>==><host>
<your-account>==><user>
```

Replace the `<your-…>` placeholders with the values reported by
`PUBLIC_BOUNDARY_ACCOUNT=<your-account> pnpm check:history` (or the paths you
know are in history). Put longer, more specific strings first. `git filter-repo`
applies literal replacements; do not put a bare account name before the full
paths.

## 4. Rewrite a fresh clone

Do not run this in the only copy. `git-filter-repo` is a separate tool:

```bash
brew install git-filter-repo        # or: pipx install git-filter-repo
git clone git@github.com:kakaCat/dsh-record-and-replay.git ../dsh-public
cd ../dsh-public

git filter-repo \
  --replace-text ../replacements.txt \
  --replace-message ../replacements.txt \
  --invert-paths --path docs/design/assets --path docs/requirements
```

This removes the design screenshots and the whole requirements archive
(requirement docs, verification material, raw M0 evidence) from every commit and
scrubs paths in blobs and commit messages. Keep the local copy under
`tmp/private-requirements/`; do not commit it.

## 5. Verify before pushing

```bash
PUBLIC_BOUNDARY_ACCOUNT=<your-account> node scripts/check-git-history.mjs  # must print "git history OK"
git log --oneline | wc -l              # compare with the pre-rewrite count
git fsck --full
pnpm install --frozen-lockfile
pnpm check:boundary
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm build
```

Also spot-check old commits:

```bash
git log --all --oneline -S"/Users/<your-account>"
git log --all --oneline -- docs/design/assets
```

Both should return nothing.

## 6. Publish and re-clone

```bash
git remote add origin git@github.com:kakaCat/dsh-record-and-replay.git
git push --force --all origin
git push --force --tags origin
```

Tell every collaborator to **re-clone**; an existing clone still has the old
objects and will reintroduce them on a force push. GitHub may keep unreachable
objects cached (PR refs, forks, object storage); for a guaranteed purge, delete
and recreate the repository, or ask GitHub Support to run a garbage collection.
Forks are independent copies and must be handled by their owners.

## 7. If anything sensitive was ever committed

Changing history is not enough. Rotate any exposed token/credential and review
the affected service logs. The public-boundary scan reports no secret shapes in
the current tree, but treat any pre-rewrite exposure as compromised.
