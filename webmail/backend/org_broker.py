"""Mail administration broker. Only the webmail process can reach this Unix socket."""

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


@app.post("/organizations/list")
def list_organizations():
    payload()
    return jsonify(organizations=org_admin.organizations())


@app.post("/organizations/create")
def create_organization():
    data = payload("domain", "name")
    return jsonify(organization=org_admin.create_organization(data["domain"], data["name"]))


@app.post("/organizations/dns")
def organization_dns():
    data = payload("domain")
    return jsonify(dns=org_admin.domain_dns(data["domain"]))


@app.post("/mailboxes/list")
def list_mailboxes():
    data = payload("domain")
    return jsonify(mailboxes=org_admin.mailboxes(data["domain"]))


@app.post("/mailboxes/create")
def create_mailbox():
    data = payload("domain", "localPart", "name", "password")
    return jsonify(mailbox=org_admin.create_mailbox(
        data["domain"], data["localPart"], data["name"], data["password"]))


@app.post("/mailboxes/status")
def set_mailbox_status():
    data = payload("domain", "email", "active")
    return jsonify(mailbox=org_admin.set_mailbox_active(data["domain"], data["email"], data["active"]))
