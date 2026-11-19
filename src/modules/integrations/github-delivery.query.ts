/**
 * The GitHub GraphQL query of the delivery history (M14-02), kept apart from the
 * normalisation in `github-delivery.ts`: when the GitHub API version changes, this is
 * the file to update. Field names here must match what the normalisers read.
 *
 * Read-only: a `query` operation cannot write. Never selected: pull request
 * descriptions, comment or review text, commit messages, diffs.
 */

export const GRAPHQL_URL = "https://api.github.com/graphql";
export const DELIVERY_BOUNDS = {
  PULL_REQUESTS: 50,
  FILES: 100,
  REVIEWS: 30,
  COMMITS: 50,
  LINKS: 10,
  RELEASES: 20,
  DEPLOYMENTS: 20,
} as const;

export const DELIVERY_QUERY = `query Delivery($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${DELIVERY_BOUNDS.PULL_REQUESTS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage }
      nodes {
        id number title url state isDraft
        createdAt updatedAt closedAt mergedAt
        baseRefName headRefName additions deletions changedFiles
        author { login }
        comments { totalCount }
        reviews(first: ${DELIVERY_BOUNDS.REVIEWS}) { totalCount nodes { id state submittedAt author { login } } }
        commits(first: ${DELIVERY_BOUNDS.COMMITS}) { totalCount nodes { commit { oid committedDate author { user { login } } } } }
        files(first: ${DELIVERY_BOUNDS.FILES}) { totalCount nodes { path additions deletions changeType } }
        closingIssuesReferences(first: ${DELIVERY_BOUNDS.LINKS}) { totalCount nodes { number url repository { nameWithOwner } } }
      }
    }
    releases(first: ${DELIVERY_BOUNDS.RELEASES}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { id tagName name url isPrerelease isDraft createdAt publishedAt }
    }
    deployments(first: ${DELIVERY_BOUNDS.DEPLOYMENTS}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { id environment createdAt commitOid latestStatus { state createdAt } }
    }
  }
}`;
