#!/usr/bin/env python3

import unittest
from unittest.mock import patch

import gh_pr_watch


class ReviewPayloadTests(unittest.TestCase):
    def test_falls_back_to_graphql_when_rest_reviews_fail(self):
        graphql_reviews = [
            {
                "id": 123,
                "user": {"login": "cursor[bot]"},
                "author_association": "NONE",
                "submitted_at": "2026-08-17T14:00:00Z",
                "body": "Looks good",
                "state": "APPROVED",
                "html_url": "https://github.com/rock3r/pioneer/pull/27#pullrequestreview-123",
            }
        ]

        with (
            patch.object(
                gh_pr_watch,
                "gh_api_list_paginated",
                side_effect=gh_pr_watch.GhCommandError("REST reviews failed"),
            ),
            patch.object(
                gh_pr_watch,
                "gh_graphql_list_reviews",
                return_value=graphql_reviews,
            ) as graphql_fetch,
        ):
            payload = gh_pr_watch.get_review_payload("rock3r/pioneer", 27)

        self.assertEqual(payload, graphql_reviews)
        graphql_fetch.assert_called_once_with("rock3r/pioneer", 27)

    def test_graphql_bot_author_uses_rest_login_shape(self):
        payload = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviews": {
                            "nodes": [
                                {
                                    "id": 123,
                                    "user": {"login": "cursor", "type": "Bot"},
                                    "author_association": "NONE",
                                    "submitted_at": "2026-08-17T14:00:00Z",
                                    "body": "Found an issue",
                                    "state": "COMMENTED",
                                    "html_url": "https://example.test/review/123",
                                }
                            ],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            }
        }

        with patch.object(gh_pr_watch, "gh_json", return_value=payload):
            reviews = gh_pr_watch.gh_graphql_list_reviews("rock3r/pioneer", 27)

        self.assertEqual(reviews[0]["user"]["login"], "cursor[bot]")

    def test_graphql_errors_fail_closed(self):
        payload = {"data": None, "errors": [{"message": "backend unavailable"}]}

        with patch.object(gh_pr_watch, "gh_json", return_value=payload):
            with self.assertRaisesRegex(gh_pr_watch.GhCommandError, "GraphQL.*reviews"):
                gh_pr_watch.gh_graphql_list_reviews("rock3r/pioneer", 27)


if __name__ == "__main__":
    unittest.main()
