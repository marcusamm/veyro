#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
docker compose exec -T worker ak shell <<'PY'
from authentik.tenants.models import Tenant
from authentik.tenants.utils import get_current_tenant

tenant = get_current_tenant()
assert tenant.ready, "Wait for authentik initialization to finish."
Tenant.objects.filter(pk=tenant.pk).update(
    base_url="https://konto.veyro.dk",
    default_user_change_email=False,
    default_user_change_username=False,
)
print("Configured Veyro system URL and administrator-managed account identifiers.")
PY
