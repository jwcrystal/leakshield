# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `jwcrystal/leakshield`. Use `gh` for tracker operations.

## Conventions

- Create: `gh issue create --repo jwcrystal/leakshield --title "..." --body-file <file>`.
- Read: `gh issue view <number> --repo jwcrystal/leakshield --comments`; inspect labels and comments when deciding status.
- List: `gh issue list --repo jwcrystal/leakshield --state open --json number,title,body,labels`.
- Comment: `gh issue comment <number> --repo jwcrystal/leakshield --body "..."`.
- Label: `gh issue edit <number> --repo jwcrystal/leakshield --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --repo jwcrystal/leakshield`.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set to `yes` only if this repo later chooses to treat external PRs as feature requests.

## Publication

When a skill says "publish to the issue tracker", create a GitHub issue. When it says "fetch the relevant ticket", read that issue and its comments.

For dependent tickets, publish blockers first and use GitHub's native issue dependencies if available. If unavailable, include `Blocked by: #<number>` in the dependent issue body. Do not close or modify a parent issue when publishing tickets.
