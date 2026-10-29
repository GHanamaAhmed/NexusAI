# Server playbook

Prepares the NexusAI server: users, SSH, firewall, Docker, swap, automatic security updates, and what releases need. It is safe to run again; a second run changes nothing. Releases themselves come from CI ([`deploy/README.md`](../../deploy/README.md)).

| Role       | What it does                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `base`     | Time zone, base packages, a swapfile, the journal's size cap, automatic security updates with a reboot at 04:30 UTC when needed |
| `users`    | `ops` (the owner, with sudo) and `deploy` (CI, limited to the deploy gate)                                                      |
| `docker`   | Docker Engine and Compose from Docker's repository, with log rotation                                                           |
| `security` | SSH by key only, for `ops` and `deploy`; fail2ban; the firewall                                                                 |
| `nexus`    | `cosign`, the folders, the release scripts, and the server's own internal passwords                                             |

## Before the first run

Install Ansible outside the repository:

```sh
python3 -m venv ~/.venvs/ansible
~/.venvs/ansible/bin/pip install "ansible-core>=2.17,<2.19"
~/.venvs/ansible/bin/ansible-galaxy collection install ansible.posix
```

The owner's key for `ops` is `~/.ssh/nexus_ops`. Make it once with `ssh-keygen -t ed25519 -f ~/.ssh/nexus_ops`.

## Running it

From this folder, always dry-run first:

```sh
# First run only, as the cloud image's account (the only one with a key before this playbook):
ansible-playbook site.yml -e ansible_user=admin7978 -e ansible_ssh_private_key_file=~/.ssh/icosnet_vps --check --diff
ansible-playbook site.yml -e ansible_user=admin7978 -e ansible_ssh_private_key_file=~/.ssh/icosnet_vps

# Every later run, as ops:
ansible-playbook site.yml --check --diff
ansible-playbook site.yml
```

`--tags` runs single roles: `base`, `users`, `docker`, `security`, `nexus`.

## Good to know

- After the first run, SSH accepts only keys, and only for `ops` and `deploy`. The cloud image's account keeps its password for the provider's web console, the way in if SSH ever locks you out.
- fail2ban bans an address for an hour after five failed SSH logins. When signing in with a specific key, add `-o IdentitiesOnly=yes`, or SSH may try other keys first and count as failures. To lift a ban, run `sudo fail2ban-client set sshd unbanip <address>` from the web console.
- To add a key, extend `ops_authorized_keys` and run again. The list is exclusive, so keys removed from it are removed from the server.
- Only Caddy may publish ports. Asterisk uses the host network, so its call-audio range (UDP 10000-10199) is opened in `firewall_allowed`.
- The provider's cloud firewall (security group) is separate from this playbook and is set in the provider's console.
