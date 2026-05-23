#!/bin/bash

# JWT Secret Generator Script
# This script generates secure random secrets for JWT authentication

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Function to print colored output
print_header() {
    echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${BLUE}║${NC}                    ${BOLD}JWT Secret Generator${NC}                                  ${BOLD}${BLUE}║${NC}"
    echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_section() {
    echo -e "${BOLD}${CYAN}$1${NC}"
    echo -e "${CYAN}$(printf '─%.0s' {1..80})${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Check if openssl is available
check_openssl() {
    if ! command -v openssl &> /dev/null; then
        print_error "openssl is not installed!"
        echo ""
        echo "Please install openssl:"
        echo "  Ubuntu/Debian: sudo apt-get install openssl"
        echo "  CentOS/RHEL:   sudo yum install openssl"
        echo "  macOS:         brew install openssl"
        exit 1
    fi
}

# Check if node is available
check_node() {
    if ! command -v node &> /dev/null; then
        print_warning "Node.js is not installed - will use openssl for all secrets"
        return 1
    fi
    return 0
}

# Generate a secure random secret (base64)
generate_secret() {
    openssl rand -base64 32
}

# Generate a long random hex string (for static token)
generate_static_token() {
    if check_node; then
        node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
    else
        openssl rand -hex 64
    fi
}

# Main script
main() {
    clear
    print_header
    
    # Check prerequisites
    check_openssl
    print_success "OpenSSL is available"
    
    if check_node; then
        print_success "Node.js is available"
    fi
    echo ""
    
    # Generate secrets
    print_section "Generating Secure Secrets"
    echo ""
    
    JWT_SECRET=$(generate_secret)
    AGENT_JWT_SECRET=$(generate_secret)
    AGENT_STATIC_TOKEN=$(generate_static_token)
    
    print_success "Generated JWT_SECRET (for user authentication)"
    print_success "Generated AGENT_JWT_SECRET (for controller → agent communication)"
    print_success "Generated AGENT_STATIC_TOKEN (for agent → controller communication)"
    echo ""
    
    # Display secrets and instructions
    print_section "Generated Secrets"
    echo ""
    
    echo -e "${BOLD}1. JWT_SECRET${NC} (User Authentication - Frontend ↔ Controller)"
    echo -e "   ${GREEN}${JWT_SECRET}${NC}"
    echo ""
    
    echo -e "${BOLD}2. AGENT_JWT_SECRET${NC} (Controller → Agent - Dynamic JWT tokens)"
    echo -e "   ${GREEN}${AGENT_JWT_SECRET}${NC}"
    echo ""
    
    echo -e "${BOLD}3. AGENT_STATIC_TOKEN${NC} (Agent → Controller - Static token)"
    echo -e "   ${GREEN}${AGENT_STATIC_TOKEN}${NC}"
    echo ""
    
    # Instructions
    print_section "Installation Instructions"
    echo ""
    
    echo -e "${BOLD}${YELLOW}STEP 1: Update Controller Backend${NC}"
    echo -e "File: ${CYAN}controller-backend/.env${NC}"
    echo ""
    echo "Add or update these lines:"
    echo -e "${GREEN}JWT_SECRET=${JWT_SECRET}${NC}"
    echo -e "${GREEN}AGENT_JWT_SECRET=${AGENT_JWT_SECRET}${NC}"
    echo -e "${GREEN}AGENT_STATIC_TOKEN=${AGENT_STATIC_TOKEN}${NC}"
    echo ""
    
    echo -e "${BOLD}${YELLOW}STEP 2: Update Agent Backend${NC}"
    echo -e "File: ${CYAN}agent-backend/.env${NC}"
    echo ""
    echo "Add or update these lines:"
    echo -e "${GREEN}AGENT_JWT_SECRET=${AGENT_JWT_SECRET}${NC}"
    echo -e "${GREEN}AGENT_JWT_TOKEN=${AGENT_STATIC_TOKEN}${NC}"
    echo ""
    
    print_warning "CRITICAL: AGENT_JWT_SECRET must be IDENTICAL in both files!"
    print_warning "CRITICAL: AGENT_STATIC_TOKEN (controller) = AGENT_JWT_TOKEN (agent)!"
    echo ""
    
    # Explanation
    print_section "How Authentication Works"
    echo ""
    
    echo -e "${BOLD}Three Types of Authentication:${NC}"
    echo ""
    echo -e "1. ${CYAN}Frontend → Controller${NC} (User Login)"
    echo "   - Uses JWT_SECRET"
    echo "   - Dynamic tokens generated on login"
    echo "   - Tokens expire after configured time"
    echo ""
    echo -e "2. ${CYAN}Controller → Agent${NC} (Trigger Backups, etc.)"
    echo "   - Uses AGENT_JWT_SECRET"
    echo "   - Dynamic tokens generated per request"
    echo "   - Controller signs, Agent verifies"
    echo ""
    echo -e "3. ${CYAN}Agent → Controller${NC} (Fetch Storage Pools, etc.)"
    echo "   - Uses AGENT_STATIC_TOKEN / AGENT_JWT_TOKEN"
    echo "   - Static token (no expiration)"
    echo "   - Simple string comparison"
    echo ""
    
    # Security notes
    print_section "Security Notes"
    echo ""
    
    print_info "JWT_SECRET: 256-bit base64 encoded (for user tokens)"
    print_info "AGENT_JWT_SECRET: 256-bit base64 encoded (for controller→agent JWT)"
    print_info "AGENT_STATIC_TOKEN: 512-bit hex encoded (for agent→controller static)"
    print_info "Never commit .env files to version control"
    print_info "Keep these secrets confidential"
    print_info "Restart both backends after updating .env files"
    echo ""
    
    # Quick copy commands
    print_section "Quick Update Commands"
    echo ""
    
    echo -e "${BOLD}Backup existing .env files:${NC}"
    echo -e "${CYAN}cp controller-backend/.env controller-backend/.env.backup${NC}"
    echo -e "${CYAN}cp agent-backend/.env agent-backend/.env.backup${NC}"
    echo ""
    
    echo -e "${BOLD}Edit .env files:${NC}"
    echo -e "${CYAN}nano controller-backend/.env${NC}"
    echo -e "${CYAN}nano agent-backend/.env${NC}"
    echo ""
    
    # Verification
    print_section "Verification Steps"
    echo ""
    
    echo "1. Verify all secrets are set:"
    echo -e "   ${CYAN}grep -E 'JWT_SECRET|AGENT_JWT_SECRET|AGENT_STATIC_TOKEN' controller-backend/.env${NC}"
    echo -e "   ${CYAN}grep -E 'AGENT_JWT_SECRET|AGENT_JWT_TOKEN' agent-backend/.env${NC}"
    echo ""
    
    echo "2. Verify AGENT_JWT_SECRET matches in both files:"
    echo -e "   ${CYAN}diff <(grep AGENT_JWT_SECRET controller-backend/.env) <(grep AGENT_JWT_SECRET agent-backend/.env)${NC}"
    echo "   (No output means they match)"
    echo ""
    
    echo "3. Verify static token matches:"
    echo -e "   ${CYAN}CONTROLLER_TOKEN=\$(grep AGENT_STATIC_TOKEN controller-backend/.env | cut -d'=' -f2)${NC}"
    echo -e "   ${CYAN}AGENT_TOKEN=\$(grep AGENT_JWT_TOKEN agent-backend/.env | cut -d'=' -f2)${NC}"
    echo -e "   ${CYAN}[ \"\$CONTROLLER_TOKEN\" = \"\$AGENT_TOKEN\" ] && echo \"✓ Tokens match\" || echo \"✗ Tokens don't match\"${NC}"
    echo ""
    
    echo "4. Restart services:"
    echo -e "   ${CYAN}cd controller-backend && npm run dev${NC}"
    echo -e "   ${CYAN}cd agent-backend && npm run dev${NC}"
    echo ""
    
    # Save to file option
    print_section "Save Secrets to File?"
    echo ""
    
    read -p "Do you want to save these secrets to a file? (y/N): " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        SECRETS_FILE="jwt-secrets-$(date +%Y%m%d-%H%M%S).txt"
        
        cat > "$SECRETS_FILE" << EOF
JWT Secrets Generated on $(date)
================================================================================

CONTROLLER BACKEND (controller-backend/.env):
----------------------------------------------
JWT_SECRET=${JWT_SECRET}
AGENT_JWT_SECRET=${AGENT_JWT_SECRET}
AGENT_STATIC_TOKEN=${AGENT_STATIC_TOKEN}


AGENT BACKEND (agent-backend/.env):
------------------------------------
AGENT_JWT_SECRET=${AGENT_JWT_SECRET}
AGENT_JWT_TOKEN=${AGENT_STATIC_TOKEN}


AUTHENTICATION FLOW:
--------------------
1. Frontend → Controller (User Login)
   - Uses: JWT_SECRET
   - Type: Dynamic JWT tokens
   
2. Controller → Agent (Trigger Backups)
   - Uses: AGENT_JWT_SECRET
   - Type: Dynamic JWT tokens
   
3. Agent → Controller (Fetch Storage Pools)
   - Uses: AGENT_STATIC_TOKEN / AGENT_JWT_TOKEN
   - Type: Static token (simple string)


IMPORTANT NOTES:
----------------
1. AGENT_JWT_SECRET must be IDENTICAL in both controller and agent .env files
2. AGENT_STATIC_TOKEN (controller) must equal AGENT_JWT_TOKEN (agent)
3. Never commit this file or .env files to version control
4. Keep these secrets confidential
5. Restart both backends after updating .env files


VERIFICATION COMMANDS:
----------------------
# Check if all secrets are set
grep -E 'JWT_SECRET|AGENT_JWT_SECRET|AGENT_STATIC_TOKEN' controller-backend/.env
grep -E 'AGENT_JWT_SECRET|AGENT_JWT_TOKEN' agent-backend/.env

# Verify AGENT_JWT_SECRET matches
diff <(grep AGENT_JWT_SECRET controller-backend/.env) <(grep AGENT_JWT_SECRET agent-backend/.env)

# Verify static token matches
CONTROLLER_TOKEN=\$(grep AGENT_STATIC_TOKEN controller-backend/.env | cut -d'=' -f2)
AGENT_TOKEN=\$(grep AGENT_JWT_TOKEN agent-backend/.env | cut -d'=' -f2)
[ "\$CONTROLLER_TOKEN" = "\$AGENT_TOKEN" ] && echo "✓ Tokens match" || echo "✗ Tokens don't match"

# Restart services
cd controller-backend && npm run dev
cd agent-backend && npm run dev
EOF
        
        print_success "Secrets saved to: ${GREEN}${SECRETS_FILE}${NC}"
        print_warning "Remember to delete this file after updating your .env files!"
        echo ""
        echo -e "To delete: ${CYAN}rm ${SECRETS_FILE}${NC}"
        echo ""
    fi
    
    # Final summary
    print_section "Summary"
    echo ""
    
    echo -e "${BOLD}What to do next:${NC}"
    echo "1. Copy JWT_SECRET to controller-backend/.env"
    echo "2. Copy AGENT_JWT_SECRET to BOTH controller-backend/.env AND agent-backend/.env"
    echo "3. Copy AGENT_STATIC_TOKEN to controller-backend/.env"
    echo "4. Copy AGENT_STATIC_TOKEN value to AGENT_JWT_TOKEN in agent-backend/.env"
    echo "5. Verify all secrets are set correctly"
    echo "6. Restart both backend services"
    echo "7. Test login and agent communication"
    echo ""
    
    print_success "Done! Your JWT secrets are ready to use."
    echo ""
}

# Run main function
main
