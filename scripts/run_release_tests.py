"""Run the explicitly selected synthetic release regression slice."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TESTS = ['backend/release_tests/test_optional_evidence.py', 'backend/release_tests/test_observations.py', 'backend/release_tests/test_reasoning_graph.py', 'backend/release_tests/test_beta_access.py::test_every_profile_read_rejects_foreign_and_unclaimed', 'backend/release_tests/test_beta_access.py::test_own_profile_allowed_and_anonymous_denied', 'backend/release_tests/test_beta_access.py::test_id_and_query_based_reads_cannot_cross_users', 'backend/release_tests/test_beta_access.py::test_foreign_mutations_rejected_before_handler_or_receipt', 'backend/release_tests/test_beta_access.py::test_mutations_need_csrf_and_existing_profile_cannot_be_duplicated', 'backend/release_tests/test_beta_access.py::test_admin_api_enforced_independently_of_navigation', 'backend/release_tests/test_support_admin_routes.py::test_real_cookie_gate_learner_and_anonymous_cannot_read_or_write', 'backend/release_tests/test_support_admin_routes.py::test_admin_disabled_and_local_enabled_fail_closed', 'backend/release_tests/test_support_admin_routes.py::test_router_cannot_be_mounted_anonymously_without_global_auth', 'backend/release_tests/test_support_admin_routes.py::test_existing_actual_csrf_protects_both_writes', 'backend/release_tests/test_support_admin_routes.py::test_existing_session_changes_are_checked_again_for_each_request', 'backend/release_tests/test_support_admin_routes.py::test_reply_atomic_status_and_owner_can_see_but_other_account_cannot', 'backend/release_tests/test_beta_email_auth.py::test_register_login_rotates_cookie_and_never_claims_legacy', 'backend/release_tests/test_beta_email_auth.py::test_invalid_request_is_decoy_without_account_enumeration', 'backend/release_tests/test_beta_email_auth.py::test_proof_context_and_expiry', 'backend/release_tests/test_beta_email_auth.py::test_five_wrong_codes_lock_even_the_correct_code', 'backend/release_tests/test_beta_email_auth.py::test_cooldown_persists_and_resend_invalidates_old_proof', 'backend/release_tests/test_beta_email_auth.py::test_provider_failure_is_not_fake_success_and_never_consumes_invite', 'backend/release_tests/test_beta_email_auth.py::test_password_routes_disabled_origin_required_and_no_code_echo', 'backend/release_tests/test_beta_user_flows.py::test_real_cookie_users_cannot_read_write_or_replay_each_others_learning', 'backend/release_tests/test_beta_user_flows.py::test_real_cookie_assessment_and_admin_boundary', 'backend/release_tests/test_sync_persistence.py', 'backend/release_tests/test_support_owner_config.py', 'backend/release_tests/test_sec_eng_storage_boundary.py']

TESTS += ['backend/release_tests/test_storage_entrypoints.py', 'backend/release_tests/test_capacity_probe.py']
TESTS += ['backend/release_tests/test_annotation_gaps.py']

def main():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    return subprocess.call([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *TESTS], cwd=ROOT, env=env)

if __name__ == "__main__":
    raise SystemExit(main())
