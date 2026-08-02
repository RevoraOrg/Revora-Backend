# Reconciliation Postmortem Usage Guide

## When to Use This Template

Complete a reconciliation postmortem for **every** SEV-level reconciliation failure:
- **SEV-1**: >$10,000 discrepancy or customer-facing balance error
- **SEV-2**: $1,000–$10,000 discrepancy or delayed settlement
- **SEV-3**: <$1,000 discrepancy, no customer impact

## Process

1. **Detect**: Reconciliation job flags a discrepancy
2. **Triage**: On-call engineer assesses severity and customer impact
3. **Mitigate**: Apply immediate fix to stop additional discrepancies
4. **Investigate**: Root cause analysis using the Five Whys
5. **Resolve**: Deploy permanent fix
6. **Document**: Complete this template within 24 hours of resolution
7. **Review**: Postmortem review meeting within 5 business days

## Template Variables

The template uses `${VARIABLE}` placeholders. Fill these in with incident-specific data:

| Variable | Description |
|----------|-------------|
| `SEVERITY` | Short severity label (e.g., "High", "Critical") |
| `SEV_LEVEL` | SEV-1, SEV-2, or SEV-3 |
| `DETECTION_TIME` | When the discrepancy was first noticed (ISO 8601) |
| `RESOLUTION_TIME` | When the permanent fix was deployed |
| `IMPACT_WINDOW` | Duration the discrepancy affected the system |

## Automation

Set up a `postmortem-init` script to pre-fill known fields from the incident management system:

```bash
# Pre-fill a postmortem from incident #${INCIDENT_ID}
./scripts/postmortem-init ${INCIDENT_ID} > docs/postmortems/reconciliation-${DATE}.md
```

## Storage

Save completed postmortems to `docs/postmortems/` with the naming convention:
```
reconciliation-YYYY-MM-DD-sev{N}.md
```
