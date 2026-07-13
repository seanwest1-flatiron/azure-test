# Testing and live validation

The normal test suite is mocked and non-live. It must not authenticate to, query, or modify an Azure or Microsoft 365 tenant.

Live integration validation is separate from the normal suite and CI. Run it only when the current task explicitly authorizes live access, and verify the expected tenant before making any change.

Authorization to validate a configuration operation does not authorize generating security activity. Failed sign-ins and other security-activity generation require separate, explicit authorization.

The failed-sign-in custom-detection validator under `tests/live` requires `AFTER_PARTY_ALLOW_LIVE_TESTS=1`, an expected tenant domain and tenant ID, and the explicit desired state `enabled`. It inspects live state before deciding whether one state-aware mutation is needed; it is not part of the normal suite or CI.
