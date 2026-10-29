# Symmetric CI drives lifecycle; no forge webhooks in v0.1

Adopting repos run `sprout deploy` on PR `opened` and `synchronize`, and
`sprout teardown` on `closed`. The gateway does not expose forge webhook
endpoints in v0.1.

Webhook-primary design was rejected for adoption: operators already run CI on
PR events; symmetric workflows are the natural contract ("add one job step").
The sweep reconciles against the forge API as a safety net when CI teardown is
missed — same role webhooks-plus-sweep played, without an always-on webhook
verification surface on the gateway.
