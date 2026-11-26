"""Mail administration broker. Only the webmail process can reach this Unix socket."""

from functools import wraps

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

import org_admin
from mailstore import MailError


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024


def payload(*keys):
    value = request.get_json(silent=True)
    if not isinstance(value, dict) or set(value) != set(keys):
        raise MailError("Ugyldige oplysninger.", 400)
    return value


def operator(*keys, platform=False):
    def decorate(handler):
        @wraps(handler)
        def checked():
            data = payload(*keys)
            # A single broker worker handles the private socket. Hold its lock
            # across role changes, live authorization and the dependent operation.
            with org_admin.WRITE_LOCK:
                scope = org_admin.access(request.headers.get("X-Veyro-Actor"))
                if scope["role"] == "none" or (platform and scope["role"] != "platform"):
                    raise org_admin.forbidden()
                if "domain" in data:
                    data["domain"] = org_admin.authorized_domain(scope, data["domain"])
                if "email" in data:
                    org_admin.check_address(data["domain"], data["email"])
                    if scope["role"] == "organization" and org_admin.has_role(data["email"]):
                        raise org_admin.forbidden()
                return handler(scope, data)
        return checked
    return decorate


def mailbox_response(box, scope):
    return jsonify(mailbox=org_admin.mailbox_role(box, org_admin.has_role(box["address"]), scope))


@app.errorhandler(org_admin.DomainProofRequired)
def proof_required(error):
    return jsonify(error=error.message, dnsChallenge=error.challenge), error.status


@app.errorhandler(MailError)
def operation_failed(error):
    return jsonify(error=error.message), error.status


@app.errorhandler(Exception)
def unexpected(error):
    if isinstance(error, HTTPException):
        return jsonify(error="Ugyldig anmodning."), error.code
    # Native exception messages can contain mailbox details or request bodies.
    app.logger.error("Mail organization operation failed (%s)", type(error).__name__)
    return jsonify(error="Mailadministrationen kunne ikke fuldføre anmodningen."), 503


@app.post("/access")
def access():
    # This display hint is repeated under the lock for each actual operation.
    payload()
    return jsonify(org_admin.access(request.headers.get("X-Veyro-Actor")))


@app.post("/organizations/list")
@operator()
def list_organizations(scope, data):
    return jsonify(organizations=org_admin.scoped_organizations(scope))


@app.post("/organizations/create")
@operator("domain", "name", platform=True)
def create_organization(scope, data):
    return jsonify(organization=org_admin.create_organization(data["domain"], data["name"]))


@app.post("/organizations/dns")
@operator("domain", platform=True)
def organization_dns(scope, data):
    return jsonify(dns=org_admin.domain_dns(data["domain"]))


@app.post("/mailboxes/list")
@operator("domain")
def list_mailboxes(scope, data):
    roles = org_admin.domain_roles(data["domain"])
    rows = org_admin.mailboxes(data["domain"])
    return jsonify(mailboxes=[org_admin.mailbox_role(box, box["address"] in roles, scope) for box in rows])


@app.post("/mailboxes/create")
@operator("domain", "localPart", "name", "password")
def create_mailbox(scope, data):
    box = org_admin.create_mailbox(data["domain"], data["localPart"], data["name"], data["password"])
    return mailbox_response(box, scope)


@app.post("/mailboxes/status")
@operator("domain", "email", "active")
def set_mailbox_status(scope, data):
    if scope["role"] == "organization" and data["active"] is not False:
        raise org_admin.forbidden()
    box = org_admin.set_mailbox_active(data["domain"], data["email"], data["active"])
    return mailbox_response(box, scope)


@app.post("/mailboxes/role")
@operator("domain", "email", "admin", platform=True)
def set_mailbox_role(scope, data):
    box = org_admin.set_role(data["domain"], data["email"], data["admin"])
    return mailbox_response(box, scope)


@app.post("/mailboxes/password")
@operator("domain", "email", "password")
def reset_mailbox_password(scope, data):
    box = org_admin.reset_password(data["domain"], data["email"], data["password"])
    return mailbox_response(box, scope)
