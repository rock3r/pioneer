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

    def test_unknown_codex_gate_blocks_merge(self):
        # A failed reactions lookup must not be read as "Codex is done".
        pr = {"closed": False, "merged": False, "mergeable": "MERGEABLE"}
        checks = {"all_terminal": True, "failed_count": 0, "pending_count": 0}
        gate = gh_pr_watch.summarize_codex_gate(None, self.summary(), self.head)
        self.assertEqual(gate["status"], "unknown")
        self.assertFalse(gh_pr_watch.is_pr_ready_to_merge(pr, checks, [], checks_terminal_elapsed=999,
            codex_gate=gate))


class ChecksTests(unittest.TestCase):
    @staticmethod
    def fake_gh_run(returncode, stdout, stderr=""):
        # Behaves like subprocess.run, including check=True raising on a nonzero exit.
        def run(cmd, check=False, **_kwargs):
            if check and returncode != 0:
                raise gh_pr_watch.subprocess.CalledProcessError(returncode, cmd, output=stdout, stderr=stderr)
            return gh_pr_watch.subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr=stderr)

        return run

    def test_get_pr_checks_reads_json_when_checks_are_pending_or_failing(self):
        # `gh pr checks` exits 8 while checks are pending and 1 when one failed,
        # but still prints the requested JSON in both cases.
        payload = '[{"name": "check", "bucket": "pending", "state": "IN_PROGRESS"}]'
        for code in (1, 8):
            with patch.object(gh_pr_watch.subprocess, "run", side_effect=self.fake_gh_run(code, payload)):
                checks = gh_pr_watch.get_pr_checks("27", repo="rock3r/pioneer")
            self.assertEqual(checks[0]["bucket"], "pending", f"exit code {code}")

    def test_get_pr_checks_still_fails_without_json(self):
        fake = self.fake_gh_run(1, "", stderr="no pull requests found")
        with patch.object(gh_pr_watch.subprocess, "run", side_effect=fake):
            with self.assertRaises(gh_pr_watch.GhCommandError):
                gh_pr_watch.get_pr_checks("27", repo="rock3r/pioneer")

    def test_other_gh_failures_still_raise_even_with_output(self):
        fake = self.fake_gh_run(4, "[]", stderr="authentication required")
        with patch.object(gh_pr_watch.subprocess, "run", side_effect=fake):
            with self.assertRaises(gh_pr_watch.GhCommandError):
                gh_pr_watch.get_pr_checks("27", repo="rock3r/pioneer")

    def test_summarize_checks_counts_cancelled_as_failed(self):
        checks = [{"name": "check", "workflow": "CI", "bucket": "cancel", "state": "CANCELLED"}]

        summary = gh_pr_watch.summarize_checks(checks)

        self.assertEqual(summary["failed_count"], 1)


class ReviewItemTests(unittest.TestCase):
    pr = {"repo": "rock3r/pioneer", "number": 27, "head_sha": "abc123"}

    @staticmethod
    def fresh_state():
        return {
            "seen_issue_comment_ids": [],
            "seen_review_comment_ids": [],
            "seen_review_ids": [],
            "last_review_poll_at": None,
        }

    @staticmethod
    def review_comment(item_id, login, association="NONE", created_at="2025-01-01T00:00:00Z",
                       body="Please fix this.", commit_id="abc123"):
        return {
            "id": item_id,
            "user": {"login": login},
            "author_association": association,
            "created_at": created_at,
            "body": body,
            "path": "src/index.ts",
            "line": 1,
            "commit_id": commit_id,
            "html_url": "https://example.test/comment",
        }

    def fetch(self, issue_comments=(), review_comments=(), unresolved=None, unresolved_error=False,
              authenticated_login="octocat"):
        if unresolved_error:
            unresolved_patch = patch.object(gh_pr_watch, "get_unresolved_review_comment_ids",
                side_effect=gh_pr_watch.GhCommandError("GraphQL unavailable"))
        else:
            unresolved_patch = patch.object(gh_pr_watch, "get_unresolved_review_comment_ids",
                return_value={"ids": set(unresolved or ()), "truncated": False})
        with patch.object(gh_pr_watch, "gh_api_list_paginated",
                          side_effect=[list(issue_comments), list(review_comments), []]), unresolved_patch:
            return gh_pr_watch.fetch_new_review_items(
                dict(self.pr), self.fresh_state(), fresh_state=True, authenticated_login=authenticated_login)

    def test_codex_review_summary_status_comment_is_not_a_review_item(self):
        # Codex edits this status table on every review; it never carries a finding.
        summary = {
            "id": 5,
            "user": {"login": "chatgpt-codex-connector[bot]"},
            "author_association": "NONE",
            "created_at": "2026-08-17T14:00:00Z",
            "body": "<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary\n",
            "html_url": "https://example.test/summary",
        }

        new_items, blocking_items = self.fetch(issue_comments=[summary])

        self.assertEqual(new_items, [])
        self.assertEqual(blocking_items, [])

    def test_codex_findings_are_still_review_items(self):
        finding = self.review_comment(6, "chatgpt-codex-connector[bot]", body="**P2** Validate the ref first")

        new_items, blocking_items = self.fetch(review_comments=[finding], unresolved={"6"})

        self.assertEqual([item["id"] for item in new_items], ["6"])
        self.assertEqual([item["id"] for item in blocking_items], ["6"])

    def test_fails_closed_when_unresolved_lookup_errors(self):
        # Without thread state an old comment on an old commit may still be open: block rather than guess.
        old = self.review_comment(42, "chatgpt-codex-connector[bot]", commit_id="0ld5ha")

        _new_items, blocking_items = self.fetch(review_comments=[old], unresolved_error=True)

        self.assertEqual([item["id"] for item in blocking_items], ["42"])

    def test_own_unresolved_threads_block_but_are_not_new_items(self):
        # The agent usually authenticates as the owner. Its own open threads must still block.
        own = self.review_comment(7, "octocat", association="OWNER", body="Rename this before merging.")

        new_items, blocking_items = self.fetch(review_comments=[own], unresolved={"7"})

        self.assertEqual(new_items, [])
        self.assertEqual([item["id"] for item in blocking_items], ["7"])

    def test_own_resolved_threads_do_not_block(self):
        own = self.review_comment(8, "octocat", association="OWNER")

        new_items, blocking_items = self.fetch(review_comments=[own], unresolved=set())

        self.assertEqual(new_items, [])
        self.assertEqual(blocking_items, [])


if __name__ == "__main__":
    unittest.main()
