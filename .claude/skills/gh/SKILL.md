---
name: gh
description: GitHub CLI reference patterns for issues, PRs, review comments, and deployments
disable-model-invocation: true
allowed-tools: ["Bash"]
---

# GitHub CLI Reference

Use `gh` CLI for all GitHub operations. Resolve the repo dynamically:

```bash
REPO_SLUG=$(gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"')
OWNER=$(echo "$REPO_SLUG" | cut -d/ -f1)
REPO=$(echo "$REPO_SLUG" | cut -d/ -f2)
```

## Issues

```bash
gh issue view 136
gh issue view -c 136                                    # with comments
gh api repos/$REPO_SLUG/issues/136/comments             # raw API
```

## Pull Requests — View & Create

```bash
gh pr view 623 --json title,body,number,reviews
gh pr create --title "feat: add feature" --body "..."
```

## Pull Requests — Update Body

`gh pr edit` may fail due to GitHub Projects Classic deprecation. Use the API:

```bash
gh api repos/$REPO_SLUG/pulls/623 -X PATCH -f body='## Summary ...'
```

## PR Review Comments — Read

```bash
# Inline code review comments (on specific lines)
gh api repos/$REPO_SLUG/pulls/623/comments

# Top-level conversation comments
gh api repos/$REPO_SLUG/issues/623/comments

# Reviews (approve/request changes)
gh api repos/$REPO_SLUG/pulls/623/reviews
```

## PR Review Comments — Reply & Resolve

```bash
# Reply to an inline review comment (by comment ID)
gh api repos/$REPO_SLUG/pulls/comments/{commentId}/replies \
  -X POST -f body="Fixed in abc1234"

# List unresolved review threads
gh api graphql -f query="
  query {
    repository(owner: \"$OWNER\", name: \"$REPO\") {
      pullRequest(number: 623) {
        reviewThreads(first: 50) {
          nodes { id isResolved comments(first: 1) { nodes { body databaseId } } }
        }
      }
    }
  }
" --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | {id, body: .comments.nodes[0].body[0:120], databaseId: .comments.nodes[0].databaseId}'

# Resolve a review thread (requires thread node ID from above)
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "PRT_..."}) {
      thread { isResolved }
    }
  }
'
```

## Deployments

```bash
# List recent deployments
gh api repos/$REPO_SLUG/deployments \
  --jq '.[0:3] | .[] | {id, sha: .sha[0:7], environment, created_at}'

# Check deployment status
gh api repos/$REPO_SLUG/deployments/{id}/statuses \
  --jq '.[0] | {state, description}'
```
