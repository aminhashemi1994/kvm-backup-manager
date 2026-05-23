# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Currently supported versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

The KVM Backup Manager team takes security bugs seriously. We appreciate your efforts to responsibly disclose your findings.

### How to Report a Security Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to:

**Mohammad Amin Hashemi**  
📧 Email: [aminhashemiwin10@gmail.com](mailto:aminhashemiwin10@gmail.com)

Please include the following information in your report:

- Type of issue (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### What to Expect

- **Acknowledgment**: You should receive an acknowledgment within 48 hours
- **Communication**: We will keep you informed about the progress of fixing the vulnerability
- **Credit**: We will credit you in the security advisory (unless you prefer to remain anonymous)
- **Timeline**: We aim to patch critical vulnerabilities within 7 days, and other vulnerabilities within 30 days

## Security Best Practices

When deploying KVM Backup Manager, please follow these security best practices:

### Authentication & Authorization

1. **Change Default Credentials**: Immediately change the default admin password after installation
2. **Use Strong Passwords**: Enforce strong password policies for all users
3. **JWT Secrets**: Generate strong, unique JWT secrets using the provided script
4. **Token Rotation**: Regularly rotate JWT secrets and API tokens

### Network Security

1. **HTTPS Only**: Always use HTTPS in production environments
2. **Firewall Rules**: Restrict access to controller and agent ports
3. **SSH Keys**: Use SSH key-based authentication, never passwords
4. **Network Segmentation**: Isolate backup network from production networks

### System Security

1. **Keep Updated**: Regularly update Node.js, npm packages, and system packages
2. **Minimal Permissions**: Run services with minimal required permissions
3. **File Permissions**: Ensure backup directories have appropriate permissions
4. **Audit Logs**: Regularly review application and system logs

### Backup Security

1. **Encryption**: Consider encrypting backup data at rest
2. **Access Control**: Limit access to backup storage locations
3. **Offsite Backups**: Store offsite backups in secure locations
4. **Backup Verification**: Regularly verify backup integrity

### Configuration Security

1. **Environment Variables**: Never commit .env files to version control
2. **Secrets Management**: Use proper secrets management solutions
3. **Configuration Review**: Regularly audit configuration files
4. **Least Privilege**: Grant minimum necessary permissions

## Known Security Considerations

### SSH Access

The agent requires SSH access to hypervisors. Ensure:
- SSH keys are properly secured
- Root access is necessary but should be monitored
- SSH access is restricted to backup operations only

### JWT Tokens

- Controller-Agent communication uses JWT tokens
- Tokens should be kept secure and rotated regularly
- Never expose JWT secrets in logs or error messages

### File System Access

- The agent requires access to backup storage paths
- Ensure proper file system permissions
- Monitor for unauthorized access attempts

## Security Updates

Security updates will be released as soon as possible after a vulnerability is confirmed. Updates will be announced through:

- GitHub Security Advisories
- Release notes
- Email to registered users (if applicable)

## Compliance

This project follows security best practices for:
- Authentication and authorization
- Data protection
- Network security
- Logging and monitoring

## Contact

For security-related questions or concerns:

**Mohammad Amin Hashemi**
- 📧 Email: [aminhashemiwin10@gmail.com](mailto:aminhashemiwin10@gmail.com)
- 💼 LinkedIn: [linkedin.com/in/amin-hashemi-2955061bb](https://www.linkedin.com/in/amin-hashemi-2955061bb)
- 🐙 GitHub: [@aminhashemi1994](https://github.com/aminhashemi1994)

## Attribution

We believe in responsible disclosure and will acknowledge security researchers who report vulnerabilities to us in a responsible manner.

---

Thank you for helping keep KVM Backup Manager and its users safe!
