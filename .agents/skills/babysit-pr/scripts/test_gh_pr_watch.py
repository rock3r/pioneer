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


class CodexGateTests(unittest.TestCase):
    head = "abcdef1234567890"

    def summary(self, commit="abcdef1", status="✅ **Completed**", login="chatgpt-codex-connector[bot]"):
        return [{"user": {"login": login}, "body":
            "<!-- codex-pull-request-review-summary -->\n"
            f"| 📝 **Code Review** | {status} | `{commit}` | PR opened |"}]

    def test_requires_completed_review_of_current_head(self):
        self.assertTrue(gh_pr_watch.summarize_codex_gate([], self.summary(), self.head)["is_success"])
        for comments in [[], self.summary("1111111"), self.summary(status="Running"),
                         self.summary(login="fake-chatgpt-codex-connector")]:
            self.assertFalse(gh_pr_watch.summarize_codex_gate([], comments, self.head)["is_success"])

    def test_unknown_reactions_and_active_review_fail_closed(self):
        for reactions in [None, [{"content": "eyes", "user": {"login": "chatgpt-codex-connector[bot]"}}]]:
            self.assertFalse(gh_pr_watch.summarize_codex_gate(reactions, self.summary(), self.head)["is_success"])

    def test_unavailable_comments_fail_closed(self):
        with patch.object(gh_pr_watch, "gh_api_list_paginated", side_effect=gh_pr_watch.GhCommandError("unavailable")):
            comments = gh_pr_watch.get_codex_summary_comments("rock3r/pioneer", 58)
        self.assertEqual(gh_pr_watch.summarize_codex_gate([], comments, self.head)["status"], "unknown")

    def test_bot_identity_is_exact_and_shared_by_reactions(self):
        self.assertFalse(gh_pr_watch.is_codex_bot_login("fake-chatgpt-codex-connector"))
        self.assertTrue(gh_pr_watch.is_codex_bot_login("chatgpt-codex-connector[bot]"))

    def test_missing_codex_blocks_merge(self):
        pr = {"closed": False, "merged": False, "mergeable": "MERGEABLE"}
        checks = {"all_terminal": True, "failed_count": 0, "pending_count": 0}
        self.assertFalse(gh_pr_watch.is_pr_ready_to_merge(pr, checks, [], checks_terminal_elapsed=999))
        self.assertTrue(gh_pr_watch.is_pr_ready_to_merge(pr, checks, [], checks_terminal_elapsed=999,
            codex_gate={"is_success": True}, bugbot_gate={"required": False}))

    def test_non_running_codex_states_return_control(self):
        pr = {"closed": False, "merged": False, "mergeable": "MERGEABLE"}
        checks = {"all_terminal": True, "failed_count": 0, "pending_count": 0}
        for status, expected in [("missing", "request_codex_review"), ("stale", "request_codex_review"),
                                 ("unknown", "diagnose_codex_review"), ("in_progress", "wait_codex")]:
            actions = gh_pr_watch.recommend_actions(pr, checks, [], [], [], 0, 3,
                checks_terminal_elapsed=999, codex_gate={"status": status, "is_success": False})
            self.assertIn(expected, actions)
            self.assertEqual(gh_pr_watch.needs_agent_attention(actions), status != "in_progress")

    def test_terminal_failure_summaries_return_diagnostic(self):
        pr = {"closed": False, "merged": False, "mergeable": "MERGEABLE"}
        checks = {"all_terminal": True, "failed_count": 0, "pending_count": 0}
        for marker in ["❌ **Failed**", "**Cancelled**", "unexpected status"]:
            gate = gh_pr_watch.summarize_codex_gate([], self.summary(status=marker), self.head)
            self.assertFalse(gate["reviewing"])
            self.assertFalse(gate["is_success"])
            actions = gh_pr_watch.recommend_actions(pr, checks, [], [], [], 0, 3,
                checks_terminal_elapsed=999, codex_gate=gate)
            self.assertIn("diagnose_codex_review", actions)
        running = gh_pr_watch.summarize_codex_gate([], self.summary(status="🔄 **Running**"), self.head)
        self.assertEqual(running["status"], "in_progress")


if __name__ == "__main__":
    unittest.main()
