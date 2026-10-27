---
name: pm-workflow
description: Use when the PM asks for any change to a repository (a fix, a feature, wording, content, configuration), asks to send work to the engineers, or asks about, updates, or fixes a change already sent as a pull request or merge request.
---

# PM workflow

The PM describes a change in plain words. You deliver a pull request (GitHub, with `gh`) or merge request (GitLab, with `glab`) that an engineer can merge, and report it with its link. The PM never runs git and never reads the diff, so every check below is yours.

Pick the CLI from `git remote get-url origin`: host `github.com` uses `gh`, any other host `glab`. If `gh auth status` or `glab auth status` fails for that host, stop and tell the PM to sign in to the code host again in the app's settings.

## 1. Confirm the goal

Look at the repository first, so the question carries what you found. Then ask one `ask_user_question` that restates, in the PM's language: what will change for the product's users, what will stay as it is, and how you will check it. Options: go ahead (recommended), adjust (the PM types what to change), cancel. Ask again only when an answer would change what you build.

The PM's go-ahead also approves pushing the branch and opening the request in steps 5 and 6.

## 2. Prepare the branch

1. `git rev-parse --show-toplevel` must print this session's folder (the base or your assigned worktree). If it does not, stop and tell the PM, in plain words, that the folder is not the project you were given. Repeat this check before every commit and push.
2. `git status --porcelain`: if there are changes you did not make in this task, they may belong to another task. Do not switch branches over them, commit them, or discard them; continue in a worktree as pi-herdr-agents describes, or ask the PM.
3. `git fetch origin`. Find the default branch with `git symbolic-ref --short refs/remotes/origin/HEAD` (run `git remote set-head origin --auto` first if it is unset) and drop the `origin/` prefix.
4. Name the branch `<type>/<slug>`: `type` is a Conventional Commits type (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`); `slug` is two to five lowercase English words joined by hyphens. Put an issue ID the PM names first in the slug (`fix/abc-123-login-timeout`). Follow the repository's own naming when its docs or recent branches show one. If the name is taken locally or on `origin`, add `-2`.
5. `git switch --no-track -c <branch> origin/<default>`.

## 3. Make the change

Follow the `coding` skill for the change itself, including its rule on when a change needs a `reviewer`. Where it asks the user to approve something (a Durable spec, a plan), ask the PM through `ask_user_question` with a plain-words summary of what users will see. Commit Durable artifacts (`docs/specs/...`) only when the repository already keeps `docs/specs/`; otherwise leave them out of the commit.

Delegate as AGENTS.md says. A `worker` commits only when its task says so; when it should, give it the branch and the commit rules of step 4.

Run the repository's own checks for the area you changed: the tests, lint, type check, and build its README, AGENTS.md, CI configuration (`.github/workflows/`, `.gitlab-ci.yml`), or package scripts define. A check that also fails on `origin/<default>` is pre-existing: note it for the request body and do not fix it in this branch. When the change alters behavior and no test covers it, add one.

Do not change CI configuration (`.github/workflows/`, `.gitlab-ci.yml`) unless the PM's request is about it; the login has no right to push workflow files on GitHub, and CI belongs to the engineers.

## 4. Commit

- Stage files by name. `git diff --cached --stat` must list only files of this task.
- Message: the repository's convention; without one, Conventional Commits `type(scope): subject`, imperative, at most 72 characters, in the language of the repository's recent commits (English when unsure). A body of one to three lines says why.
- No mention of AI tools, no AI co-author line.
- Never amend or squash a commit that is already pushed.

## 5. Push

`git push -u origin <branch>`. Never `--force` or `--force-with-lease`, never the default branch.

- Rejected because the remote branch has commits you lack: `git pull --no-rebase origin <branch>`, rerun the checks, push again.
- Rejected for login or permission: stop and tell the PM to check the code-host account in the app's settings, and that their account may lack write access to this project.

## 6. Open the pull or merge request

Write the title and body to files under `$(git rev-parse --git-dir)/pm-workflow/`, never in the working tree.

- Title, in the PM's language: what changes for users, in one line.
- Body, in the PM's language, with these sections: the request (the PM's words, quoted); what changed for users; how it was checked (each check with its result); review (the reviewer's result and P2 and P3 follow-ups, or "no review needed" with the reason); notes for the engineer (pre-existing failures, decisions the PM made through your questions).
- Mark it draft when a check could not run or a review stopped with findings unresolved.

If the branch already has an open request, update its title and body instead of opening another. Commands are in the table at the end. The command prints the link.

## 7. Wait for CI

Wait up to 15 minutes for the checks on the request (commands in the table).

- All passed, or the repository has no CI: go to step 8.
- A check failed: read each failed job's log. If this change caused it, fix it, rerun the local checks, commit, push, and wait again, at most two rounds. If it also fails on the default branch, or comes from the CI service itself (a timeout, a missing secret, a runner that never started), change nothing: explain it in a comment on the request and tell the PM.
- Still running after 15 minutes: report with the link and say CI is still running.
- Never disable, skip, or delete a test or CI job to make it pass.

## 8. Report

Tell the PM, in plain words and their language:

- what changed, as the product's users will see it;
- how it was checked: tests, review when there was one, and CI, each with its result;
- the link, and one line on what it is (for example 「合併請求（PR）：請工程師把這次修改併進正式版本的申請」);
- what happens next: an engineer reviews and merges it, and the PM can ask for changes until then.

Anything the PM must decide goes into an `ask_user_question`, not into the report.

## Conflicts

When the request shows it cannot merge cleanly, or the engineer asks to bring the branch up to date: `git fetch origin`, then `git merge origin/<default>`. Merge, do not rebase, so no force-push is needed.

- Resolve a conflict yourself when the intent of both sides is clear from the code.
- When both sides changed the same visible wording or behavior, ask the PM with `ask_user_question`, showing both versions in plain words.
- When you cannot judge a conflict, run `git merge --abort`, leave the branch as it was, and tell the PM an engineer has to resolve it.

After resolving: rerun the checks, commit the merge, push, and wait for CI again (step 7).

## Follow-ups on a sent request

When the PM asks about a sent change or passes on an engineer's comment, read the request's state, checks, and comments. Continue on the same branch only when the working tree is clean (otherwise in a worktree), go through steps 3 to 7 again, and report. A merged or closed request is finished: new work starts a new branch from step 2.

## Code-host commands

Use only these. Never `gh pr merge`, `glab mr merge`, or any `auth` command but `status`.

| Step | GitHub (`gh`) | GitLab (`glab`) |
| --- | --- | --- |
| Find the open request | `gh pr list --head <branch> --state open --json number,url` | `glab mr list --source-branch <branch> -F json` |
| Open | `gh pr create --base <default> --head <branch> --title "<title>" --body-file <file> [--draft]` | `glab mr create --source-branch <branch> --target-branch <default> --title "<title>" --description-file <file> [--draft] --yes` |
| Update | `gh pr edit <n> --title "<title>" --body-file <file>` | `glab mr update <iid> --title "<title>" --description-file <file>` |
| State and mergeability | `gh pr view <n> --json state,isDraft,mergeable,mergeStateStatus,url` | `glab mr view <iid> -F json` (`state`, `detailed_merge_status`, `has_conflicts`) |
| Wait for checks | `timeout 900 gh pr checks <n> --watch --interval 30`, then `gh pr checks <n> --json name,bucket,link` | `glab ci get --branch <branch> -F json`, every 30 s for up to 15 minutes while the pipeline is `created`, `pending`, or `running` |
| Failed job log | `gh run view --job <job id from the check link> --log-failed` | `glab ci trace <job id> \| tail -n 200` |
| Comments | `gh pr view <n> --comments` | `glab mr view <iid> --comments` |
| Add a comment | `gh pr comment <n> --body-file <file>` | `glab mr note create <iid> --message "$(cat <file>)"` |
