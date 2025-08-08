from fastapi import FastAPI, APIRouter, Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, EmailStr
from pydantic_settings import BaseSettings
from typing import Optional, List, Dict, Any, Union
import os
import logging
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from supabase import create_client, Client
import jwt
from jwt.exceptions import PyJWTError, ExpiredSignatureError, InvalidTokenError
from enum import Enum

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Configuration
class Settings(BaseSettings):
    supabase_url: str = os.environ.get('SUPABASE_URL', '')
    supabase_anon_key: str = os.environ.get('SUPABASE_ANON_KEY', '')
    supabase_service_role_key: str = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    supabase_jwt_secret: str = os.environ.get('SUPABASE_JWT_SECRET', '')
    debug: bool = os.environ.get('DEBUG', 'false').lower() == 'true'

settings = Settings()

# Supabase client
supabase: Client = create_client(settings.supabase_url, settings.supabase_service_role_key)

# JWT Handler
class JWTHandler:
    def __init__(self):
        self.secret_key = settings.supabase_jwt_secret
        self.algorithm = "HS256"
        self.audience = "authenticated"

    def decode_token(self, token: str) -> Dict[str, Any]:
        try:
            payload = jwt.decode(
                token,
                self.secret_key,
                algorithms=[self.algorithm],
                audience=self.audience
            )
            return payload
        except ExpiredSignatureError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has expired",
                headers={"WWW-Authenticate": "Bearer"},
            )
        except InvalidTokenError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token",
                headers={"WWW-Authenticate": "Bearer"},
            )
        except PyJWTError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Could not validate credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )

    def get_user_id(self, payload: Dict[str, Any]) -> str:
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token does not contain user ID",
            )
        return user_id

    def get_user_email(self, payload: Dict[str, Any]) -> str:
        email = payload.get("email")
        if not email:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token does not contain user email",
            )
        return email

jwt_handler = JWTHandler()

# Models
class UserRole(str, Enum):
    SAAS_SUPER_ADMIN = "saas_super_admin"
    SAAS_ADMIN = "saas_admin"
    SAAS_ACCOUNTANT = "saas_accountant"
    ORGANIZATION_OWNER = "organization_owner"
    ORGANIZATION_ADMIN = "organization_admin"
    ORGANIZATION_USER = "organization_user"

class SubscriptionTier(str, Enum):
    FREE = "free"
    STARTER = "starter"
    PROFESSIONAL = "professional"
    ENTERPRISE = "enterprise"

class UserProfile(BaseModel):
    id: str
    email: EmailStr
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    avatar_url: Optional[str] = None
    phone: Optional[str] = None
    timezone: str = "UTC"
    created_at: datetime
    updated_at: datetime
    last_login: Optional[datetime] = None
    is_active: bool = True

    @property
    def full_name(self) -> str:
        if self.first_name and self.last_name:
            return f"{self.first_name} {self.last_name}"
        return self.first_name or self.last_name or self.email

class Organization(BaseModel):
    id: str
    name: str
    domain: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    is_active: bool = True
    subscription_tier: SubscriptionTier = SubscriptionTier.FREE
    max_users: int = 5
    settings: Dict[str, Any] = {}

class OrganizationMembership(BaseModel):
    id: str
    user_id: str
    organization_id: str
    role: UserRole
    invited_by: Optional[str] = None
    invited_at: datetime
    accepted_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    is_active: bool = True
    organization: Optional[Organization] = None

class UserContext(BaseModel):
    id: str
    email: EmailStr
    profile: UserProfile
    memberships: List[OrganizationMembership] = []
    raw_payload: Dict[str, Any] = {}

    def get_membership_for_organization(self, org_id: str) -> Optional[OrganizationMembership]:
        for membership in self.memberships:
            if membership.organization_id == org_id and membership.is_active:
                return membership
        return None

    def has_minimum_role_in_organization(self, org_id: str, min_role: UserRole) -> bool:
        role_hierarchy = {
            UserRole.ORGANIZATION_USER: 1,
            UserRole.ORGANIZATION_ADMIN: 2,
            UserRole.ORGANIZATION_OWNER: 3,
            UserRole.SAAS_ACCOUNTANT: 4,
            UserRole.SAAS_ADMIN: 5,
            UserRole.SAAS_SUPER_ADMIN: 6
        }
        
        membership = self.get_membership_for_organization(org_id)
        if not membership:
            return False

        user_level = role_hierarchy.get(membership.role, 0)
        min_level = role_hierarchy.get(min_role, 0)
        
        return user_level >= min_level

    def has_saas_role(self) -> bool:
        saas_roles = {UserRole.SAAS_ACCOUNTANT, UserRole.SAAS_ADMIN, UserRole.SAAS_SUPER_ADMIN}
        return any(membership.role in saas_roles for membership in self.memberships)

# Auth Dependencies
security = HTTPBearer(auto_error=False)

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> UserContext:
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = jwt_handler.decode_token(credentials.credentials)
        user_id = jwt_handler.get_user_id(payload)
        email = jwt_handler.get_user_email(payload)

        # Load user profile
        result = supabase.table("user_profiles").select("*").eq("id", user_id).single().execute()
        if not result.data:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User profile not found")
        
        profile = UserProfile(**result.data)

        # Load memberships
        memberships_result = supabase.table("organization_memberships").select("""
            *,
            organization:organizations(*)
        """).eq("user_id", user_id).eq("is_active", True).execute()
        
        memberships = []
        if memberships_result.data:
            for item in memberships_result.data:
                org_data = item.pop("organization", {})
                membership = OrganizationMembership(**item)
                if org_data:
                    membership.organization = Organization(**org_data)
                memberships.append(membership)

        return UserContext(
            id=user_id,
            email=email,
            profile=profile,
            memberships=memberships,
            raw_payload=payload
        )

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error in get_current_user: {str(e)}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication failed")

# Request/Response Models
class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None

class OrganizationCreate(BaseModel):
    name: str
    domain: Optional[str] = None

class InviteUserRequest(BaseModel):
    email: EmailStr
    role: UserRole = UserRole.ORGANIZATION_USER
    first_name: Optional[str] = None
    last_name: Optional[str] = None

class DashboardStats(BaseModel):
    total_organizations: int
    total_users: int
    active_campaigns: int
    total_messages_sent: int

# Create the main app
app = FastAPI(title="WhatsApp Automation SaaS API", version="1.0.0")

# Create API router
api_router = APIRouter(prefix="/api")

# Auth endpoints
@api_router.post("/auth/login")
async def login(request: LoginRequest):
    try:
        response = supabase.auth.sign_in_with_password({
            "email": request.email,
            "password": request.password
        })
        
        if response.user:
            return {
                "access_token": response.session.access_token,
                "token_type": "bearer",
                "expires_in": response.session.expires_in,
                "user": response.user
            }
        else:
            raise HTTPException(status_code=401, detail="Invalid credentials")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@api_router.post("/auth/register")
async def register(request: RegisterRequest):
    try:
        response = supabase.auth.sign_up({
            "email": request.email,
            "password": request.password,
            "options": {
                "data": {
                    "first_name": request.first_name,
                    "last_name": request.last_name,
                    "phone": request.phone
                }
            }
        })
        
        return {
            "message": "Registration successful. Please check your email to verify your account.",
            "user_id": response.user.id if response.user else None
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@api_router.get("/auth/me")
async def get_me(current_user: UserContext = Depends(get_current_user)):
    return {
        "user": current_user.profile,
        "memberships": current_user.memberships
    }

# Dashboard endpoints
@api_router.get("/dashboard/stats")
async def get_dashboard_stats(current_user: UserContext = Depends(get_current_user)):
    if current_user.has_saas_role():
        # SaaS admin sees global stats
        orgs = supabase.table("organizations").select("count", count="exact").execute()
        users = supabase.table("user_profiles").select("count", count="exact").execute()
        
        return DashboardStats(
            total_organizations=orgs.count or 0,
            total_users=users.count or 0,
            active_campaigns=0,  # Placeholder
            total_messages_sent=0  # Placeholder
        )
    else:
        # Regular user sees org-specific stats
        return DashboardStats(
            total_organizations=len(current_user.memberships),
            total_users=0,  # Placeholder - would count users in their orgs
            active_campaigns=0,
            total_messages_sent=0
        )

# Organization endpoints
@api_router.get("/organizations")
async def get_organizations(current_user: UserContext = Depends(get_current_user)):
    if current_user.has_saas_role():
        # SaaS admin can see all organizations
        result = supabase.table("organizations").select("*").execute()
        return [Organization(**org) for org in result.data] if result.data else []
    else:
        # Regular users see only their organizations
        return [membership.organization for membership in current_user.memberships 
                if membership.organization]

@api_router.post("/organizations")
async def create_organization(
    request: OrganizationCreate, 
    current_user: UserContext = Depends(get_current_user)
):
    try:
        # Create organization
        org_result = supabase.table("organizations").insert({
            "name": request.name,
            "domain": request.domain,
        }).execute()
        
        if not org_result.data:
            raise HTTPException(status_code=400, detail="Failed to create organization")
        
        org_data = org_result.data[0]
        organization = Organization(**org_data)
        
        # Create membership for creator as owner
        supabase.table("organization_memberships").insert({
            "user_id": current_user.id,
            "organization_id": organization.id,
            "role": UserRole.ORGANIZATION_OWNER.value,
            "invited_by": current_user.id,
            "invited_at": datetime.utcnow().isoformat(),
            "accepted_at": datetime.utcnow().isoformat(),
        }).execute()
        
        return organization
        
    except Exception as e:
        logging.error(f"Error creating organization: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

@api_router.get("/organizations/{org_id}/members")
async def get_organization_members(
    org_id: str, 
    current_user: UserContext = Depends(get_current_user)
):
    # Check if user has access to this organization
    if not current_user.has_saas_role():
        membership = current_user.get_membership_for_organization(org_id)
        if not membership or not current_user.has_minimum_role_in_organization(org_id, UserRole.ORGANIZATION_ADMIN):
            raise HTTPException(status_code=403, detail="Access denied")
    
    result = supabase.table("organization_memberships").select("""
        *,
        user_profile:user_profiles(*)
    """).eq("organization_id", org_id).eq("is_active", True).execute()
    
    members = []
    if result.data:
        for item in result.data:
            profile_data = item.pop("user_profile", {})
            member = {**item}
            if profile_data:
                member["user_profile"] = UserProfile(**profile_data)
            members.append(member)
    
    return members

@api_router.post("/organizations/{org_id}/invite")
async def invite_user_to_organization(
    org_id: str,
    request: InviteUserRequest,
    current_user: UserContext = Depends(get_current_user)
):
    # Check permissions
    if not current_user.has_saas_role():
        membership = current_user.get_membership_for_organization(org_id)
        if not membership or not current_user.has_minimum_role_in_organization(org_id, UserRole.ORGANIZATION_ADMIN):
            raise HTTPException(status_code=403, detail="Access denied")
    
    try:
        # Check if user already exists
        user_result = supabase.table("user_profiles").select("id").eq("email", request.email).execute()
        
        if user_result.data:
            user_id = user_result.data[0]["id"]
            
            # Check if membership already exists
            existing = supabase.table("organization_memberships").select("id").eq(
                "user_id", user_id
            ).eq("organization_id", org_id).execute()
            
            if existing.data:
                raise HTTPException(status_code=400, detail="User already a member")
            
            # Create membership
            supabase.table("organization_memberships").insert({
                "user_id": user_id,
                "organization_id": org_id,
                "role": request.role.value,
                "invited_by": current_user.id,
                "invited_at": datetime.utcnow().isoformat(),
                "accepted_at": datetime.utcnow().isoformat(),
            }).execute()
            
            return {"message": "User invited successfully"}
        else:
            # TODO: Handle invitation of non-existing users
            raise HTTPException(status_code=400, detail="User not found. User must register first.")
            
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error inviting user: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

# Plans and Features endpoints (placeholder)
@api_router.get("/plans")
async def get_plans():
    return [
        {
            "id": "free",
            "name": "Free",
            "price": 0,
            "features": ["5 Users", "Basic WhatsApp Integration", "100 Messages/month"]
        },
        {
            "id": "starter",
            "name": "Starter", 
            "price": 29,
            "features": ["25 Users", "Advanced Automation", "5,000 Messages/month", "Analytics"]
        },
        {
            "id": "professional",
            "name": "Professional",
            "price": 99,
            "features": ["100 Users", "Multi-channel Integration", "50,000 Messages/month", "API Access"]
        },
        {
            "id": "enterprise",
            "name": "Enterprise",
            "price": 299,
            "features": ["Unlimited Users", "Custom Integrations", "Unlimited Messages", "Priority Support"]
        }
    ]

# WhatsApp endpoints (placeholder)
@api_router.get("/whatsapp/campaigns")
async def get_campaigns(current_user: UserContext = Depends(get_current_user)):
    return []  # Placeholder - would fetch campaigns from database

@api_router.get("/whatsapp/templates")
async def get_templates(current_user: UserContext = Depends(get_current_user)):
    return []  # Placeholder - would fetch templates from database

@api_router.get("/whatsapp/contacts")
async def get_contacts(current_user: UserContext = Depends(get_current_user)):
    return []  # Placeholder - would fetch contacts from database

# Health check
@api_router.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.utcnow()}

# Include router
app.include_router(api_router)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],  # In production, specify exact origins
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)