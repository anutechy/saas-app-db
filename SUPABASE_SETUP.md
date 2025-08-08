# Supabase Setup Guide for WhatsApp Automation SaaS

## 1. Database Schema Setup

Execute the following SQL commands in your Supabase SQL Editor:

### Step 1: Create User Roles Enum

```sql
-- User roles enumeration for our 6-level system
CREATE TYPE user_role AS ENUM (
    'saas_super_admin',    -- Highest level: Full system access
    'saas_admin',          -- System admin: Cross-tenant management
    'saas_accountant',     -- Financial access: Billing and reporting
    'organization_owner',   -- Tenant owner: Full org access
    'organization_admin',   -- Tenant admin: User and settings management
    'organization_user'     -- Basic user: Limited access within org
);
```

### Step 2: Create Organizations Table

```sql
-- Organizations table (primary tenant entity)
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    subscription_tier VARCHAR(50) DEFAULT 'free',
    max_users INTEGER DEFAULT 5,
    settings JSONB DEFAULT '{}'::JSONB
);

-- Enable RLS on organizations table
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
```

### Step 3: Create User Profiles Table

```sql
-- User profiles table (extends auth.users)
CREATE TABLE user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL UNIQUE,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    avatar_url TEXT,
    phone VARCHAR(20),
    timezone VARCHAR(50) DEFAULT 'UTC',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE
);

-- Enable RLS on user_profiles table
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
```

### Step 4: Create Organization Memberships Table

```sql
-- Organization memberships (many-to-many with roles)
CREATE TABLE organization_memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    role user_role NOT NULL DEFAULT 'organization_user',
    invited_by UUID REFERENCES user_profiles(id),
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(user_id, organization_id)
);

-- Enable RLS on organization_memberships table
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
```

### Step 5: Create RLS Policies

```sql
-- RLS Policies for organizations table
CREATE POLICY "Users can view organizations they belong to" ON organizations
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM organization_memberships om
            WHERE om.organization_id = organizations.id
            AND om.user_id = auth.uid()
            AND om.is_active = true
        )
    );

CREATE POLICY "Organization owners can update their organization" ON organizations
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM organization_memberships om
            WHERE om.organization_id = organizations.id
            AND om.user_id = auth.uid()
            AND om.role IN ('organization_owner', 'organization_admin')
            AND om.is_active = true
        )
    );

CREATE POLICY "Users can create organizations" ON organizations
    FOR INSERT WITH CHECK (true);

-- RLS Policies for user_profiles table
CREATE POLICY "Users can view their own profile" ON user_profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON user_profiles
    FOR UPDATE USING (auth.uid() = id);

-- RLS Policies for organization_memberships table
CREATE POLICY "Users can view memberships in their organizations" ON organization_memberships
    FOR SELECT USING (
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM organization_memberships om
            WHERE om.organization_id = organization_memberships.organization_id
            AND om.user_id = auth.uid()
            AND om.role IN ('organization_owner', 'organization_admin')
            AND om.is_active = true
        )
    );

CREATE POLICY "Organization admins can manage memberships" ON organization_memberships
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM organization_memberships om
            WHERE om.organization_id = organization_memberships.organization_id
            AND om.user_id = auth.uid()
            AND om.role IN ('organization_owner', 'organization_admin')
            AND om.is_active = true
        ) OR auth.uid() = user_id
    );
```

### Step 6: Create Database Functions

```sql
-- Function to get user's role in a specific organization
CREATE OR REPLACE FUNCTION get_user_role_in_organization(org_id UUID, user_id UUID DEFAULT auth.uid())
RETURNS user_role AS $$
DECLARE
    user_role_result user_role;
BEGIN
    SELECT role INTO user_role_result
    FROM organization_memberships
    WHERE organization_id = org_id
    AND organization_memberships.user_id = get_user_role_in_organization.user_id
    AND is_active = true;
    
    RETURN user_role_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user has minimum required role
CREATE OR REPLACE FUNCTION user_has_minimum_role(
    org_id UUID,
    required_role user_role,
    user_id UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN AS $$
DECLARE
    user_current_role user_role;
    current_role_level INTEGER;
    required_role_level INTEGER;
BEGIN
    user_current_role := get_user_role_in_organization(org_id, user_id);
    
    IF user_current_role IS NULL THEN
        RETURN FALSE;
    END IF;
    
    -- Map roles to hierarchy levels
    current_role_level := CASE user_current_role
        WHEN 'saas_super_admin' THEN 6
        WHEN 'saas_admin' THEN 5
        WHEN 'saas_accountant' THEN 4
        WHEN 'organization_owner' THEN 3
        WHEN 'organization_admin' THEN 2
        WHEN 'organization_user' THEN 1
        ELSE 0
    END;
    
    required_role_level := CASE required_role
        WHEN 'saas_super_admin' THEN 6
        WHEN 'saas_admin' THEN 5
        WHEN 'saas_accountant' THEN 4
        WHEN 'organization_owner' THEN 3
        WHEN 'organization_admin' THEN 2
        WHEN 'organization_user' THEN 1
        ELSE 0
    END;
    
    RETURN current_role_level >= required_role_level;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Step 7: Create Triggers

```sql
-- Trigger to create user profile on auth user creation
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_profiles (id, email, first_name, last_name)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data->>'first_name',
        NEW.raw_user_meta_data->>'last_name'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION create_user_profile();

-- Trigger to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_organization_memberships_updated_at
    BEFORE UPDATE ON organization_memberships
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## 2. Environment Variables Setup

You need to get the following from your Supabase dashboard:

1. Go to Settings → API in your Supabase dashboard
2. Copy the following values:

- **Project URL**: Already configured
- **Anon Key**: Already configured  
- **Service Role Key**: Copy this from the dashboard
- **JWT Secret**: Found in Settings → API → JWT Settings

Update your `/app/backend/.env` file with these values:

```env
SUPABASE_SERVICE_ROLE_KEY=your_actual_service_role_key_here
SUPABASE_JWT_SECRET=your_actual_jwt_secret_here
```

## 3. Test Data Setup (Optional)

After setting up the schema, you can create test data:

```sql
-- Create a test organization
INSERT INTO organizations (name, domain, subscription_tier) 
VALUES ('Demo Company', 'demo.com', 'professional');

-- You'll need to register users through the app first, then manually assign roles if needed
```

## 4. Authentication Configuration

In Supabase Dashboard:
1. Go to Authentication → Settings
2. Enable Email confirmations if desired
3. Configure redirect URLs to include your domain
4. Set up email templates as needed

## 5. Testing the Setup

Once you've completed the above steps:
1. Restart your backend server
2. Try registering a new user
3. Create an organization
4. Test the role-based access system

The application will now support:
- ✅ Multi-tenant architecture with 6 role levels
- ✅ Users can belong to multiple organizations  
- ✅ Dynamic role-based permissions
- ✅ Secure Row Level Security policies
- ✅ Automatic user profile creation
- ✅ Organization management
- ✅ Real-time authentication state management