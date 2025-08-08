import React, { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import './App.css';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Supabase configuration
const supabaseUrl = 'https://gcilguomdshglmefkdfk.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjaWxndW9tZHNoZ2xtZWZrZGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ2NDI2NjksImV4cCI6MjA3MDIxODY2OX0.7rqQKFB9JGwxKzuZ3dAKnIvkEPCqzLlMdu1J38Xu_Kk';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Auth Context
const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [memberships, setMemberships] = useState([]);
  const [currentOrganization, setCurrentOrganization] = useState(null);
  const [loading, setLoading] = useState(true);

  const roleHierarchy = {
    'organization_user': 1,
    'organization_admin': 2,
    'organization_owner': 3,
    'saas_accountant': 4,
    'saas_admin': 5,
    'saas_super_admin': 6
  };

  useEffect(() => {
    // Get initial session
    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user) {
        await loadUserData(session.access_token);
      }
      setLoading(false);
    };

    getSession();

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        
        if (session?.user) {
          await loadUserData(session.access_token);
        } else {
          setProfile(null);
          setMemberships([]);
          setCurrentOrganization(null);
        }
        setLoading(false);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const loadUserData = async (token) => {
    try {
      const response = await axios.get(`${API}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setProfile(response.data.user);
      setMemberships(response.data.memberships || []);
      
      if (response.data.memberships && response.data.memberships.length > 0) {
        const highestRole = response.data.memberships.reduce((prev, current) => 
          roleHierarchy[current.role] > roleHierarchy[prev.role] ? current : prev
        );
        setCurrentOrganization(highestRole);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    return { data, error };
  };

  const signUp = async (email, password, userData = {}) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: userData
      }
    });
    return { data, error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setMemberships([]);
    setCurrentOrganization(null);
  };

  const hasMinimumRole = (minRole, orgId) => {
    const targetOrgId = orgId || currentOrganization?.organization_id;
    if (!targetOrgId) return false;

    const membership = memberships.find(m => 
      m.organization_id === targetOrgId && m.is_active
    );
    
    if (!membership) return false;

    const userRoleLevel = roleHierarchy[membership.role] || 0;
    const minRoleLevel = roleHierarchy[minRole] || 0;
    
    return userRoleLevel >= minRoleLevel;
  };

  const hasSaasRole = () => {
    const saasRoles = ['saas_accountant', 'saas_admin', 'saas_super_admin'];
    return memberships.some(m => saasRoles.includes(m.role));
  };

  const value = {
    user,
    session,
    profile,
    memberships,
    currentOrganization,
    loading,
    signIn,
    signUp,
    signOut,
    setCurrentOrganization,
    hasMinimumRole,
    hasSaasRole
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

// Protected Route Component
const ProtectedRoute = ({ children, requireAuth = true, requiredRole = null }) => {
  const { user, loading, hasMinimumRole, currentOrganization } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading your account...</p>
        </div>
      </div>
    );
  }

  if (requireAuth && !user) {
    return <Navigate to="/auth" replace />;
  }

  if (requireAuth && !currentOrganization) {
    return <Navigate to="/onboarding" replace />;
  }

  if (requiredRole && !hasMinimumRole(requiredRole)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
};

// Auth Components
const AuthForm = () => {
  const { signIn, signUp } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    firstName: '',
    lastName: '',
    phone: ''
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isLogin) {
        const { error } = await signIn(formData.email, formData.password);
        if (error) {
          setError(error.message);
        } else {
          navigate('/dashboard');
        }
      } else {
        if (formData.password !== formData.confirmPassword) {
          setError('Passwords do not match');
          setLoading(false);
          return;
        }

        const { error } = await signUp(formData.email, formData.password, {
          first_name: formData.firstName,
          last_name: formData.lastName,
          phone: formData.phone
        });
        
        if (error) {
          setError(error.message);
        } else {
          setError('');
          alert('Registration successful! Please check your email to verify your account.');
          setIsLogin(true);
        }
      }
    } catch (err) {
      setError('An unexpected error occurred');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h2 className="mt-6 text-3xl font-bold text-gray-900">
            {isLogin ? 'Sign in to your account' : 'Create your account'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            WhatsApp Automation SaaS Platform
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-lg p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            {!isLogin && (
              <div className="grid grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="First Name"
                  value={formData.firstName}
                  onChange={(e) => setFormData({...formData, firstName: e.target.value})}
                  className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  required
                />
                <input
                  type="text"
                  placeholder="Last Name"
                  value={formData.lastName}
                  onChange={(e) => setFormData({...formData, lastName: e.target.value})}
                  className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  required
                />
              </div>
            )}

            <input
              type="email"
              placeholder="Email address"
              value={formData.email}
              onChange={(e) => setFormData({...formData, email: e.target.value})}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              required
            />

            {!isLogin && (
              <input
                type="tel"
                placeholder="Phone (optional)"
                value={formData.phone}
                onChange={(e) => setFormData({...formData, phone: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}

            <input
              type="password"
              placeholder="Password"
              value={formData.password}
              onChange={(e) => setFormData({...formData, password: e.target.value})}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              required
            />

            {!isLogin && (
              <input
                type="password"
                placeholder="Confirm Password"
                value={formData.confirmPassword}
                onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                required
              />
            )}

            {error && (
              <div className="text-red-600 text-sm text-center bg-red-50 p-3 rounded-md">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Please wait...' : (isLogin ? 'Sign In' : 'Sign Up')}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => setIsLogin(!isLogin)}
                className="text-sm text-indigo-600 hover:text-indigo-500"
              >
                {isLogin ? "Don't have an account? Sign up" : "Already have an account? Sign in"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

// Organization Switcher
const OrganizationSwitcher = () => {
  const { memberships, currentOrganization, setCurrentOrganization } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

  if (memberships.length <= 1) return null;

  const getRoleColor = (role) => {
    const colors = {
      'saas_super_admin': 'bg-red-100 text-red-800',
      'saas_admin': 'bg-purple-100 text-purple-800',
      'saas_accountant': 'bg-blue-100 text-blue-800',
      'organization_owner': 'bg-green-100 text-green-800',
      'organization_admin': 'bg-yellow-100 text-yellow-800',
      'organization_user': 'bg-gray-100 text-gray-800'
    };
    return colors[role] || 'bg-gray-100 text-gray-800';
  };

  const formatRole = (role) => {
    return role.split('_').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <div className="flex-1 text-left">
          <div className="text-sm font-medium text-gray-900">
            {currentOrganization?.organization?.name || 'Select Organization'}
          </div>
          {currentOrganization && (
            <div className={`text-xs px-2 py-1 rounded ${getRoleColor(currentOrganization.role)} inline-block mt-1`}>
              {formatRole(currentOrganization.role)}
            </div>
          )}
        </div>
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-300 rounded-lg shadow-lg z-50">
          <div className="p-3 border-b border-gray-200">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Your Organizations</h3>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {memberships.map((membership) => (
              <button
                key={membership.id}
                onClick={() => {
                  setCurrentOrganization(membership);
                  setIsOpen(false);
                }}
                className={`w-full px-4 py-3 text-left hover:bg-gray-50 focus:outline-none focus:bg-gray-50 ${
                  currentOrganization?.id === membership.id ? 'bg-indigo-50' : ''
                }`}
              >
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center">
                    <span className="text-sm font-medium text-indigo-600">
                      {membership.organization?.name?.charAt(0) || 'O'}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      {membership.organization?.name}
                    </div>
                    <div className="flex items-center space-x-2 mt-1">
                      <span className={`text-xs px-2 py-1 rounded ${getRoleColor(membership.role)}`}>
                        {formatRole(membership.role)}
                      </span>
                      <span className="text-xs text-gray-500 border border-gray-300 px-2 py-1 rounded">
                        {membership.organization?.subscription_tier || 'free'}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Dashboard Component
const Dashboard = () => {
  const { profile, memberships, currentOrganization, hasSaasRole, signOut } = useAuth();
  const [stats, setStats] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const navigate = useNavigate();

  useEffect(() => {
    loadDashboardData();
  }, [currentOrganization]);

  const loadDashboardData = async () => {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      
      // Load stats
      const statsResponse = await axios.get(`${API}/dashboard/stats`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setStats(statsResponse.data);

      // Load organizations
      const orgsResponse = await axios.get(`${API}/organizations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setOrganizations(orgsResponse.data);
    } catch (error) {
      console.error('Error loading dashboard data:', error);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-4">
              <h1 className="text-2xl font-bold text-gray-900">WhatsApp Automation</h1>
              <OrganizationSwitcher />
            </div>
            
            <div className="flex items-center space-x-4">
              <div className="text-sm text-gray-600">
                Welcome, {profile?.first_name || profile?.email}
              </div>
              <button
                onClick={handleSignOut}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8" aria-label="Tabs">
            {['overview', 'organizations', 'campaigns', 'analytics'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-4m-5 0H9m0 0H5m4 0V9a2 2 0 012-2h2a2 2 0 012 2v12M13 7a1 1 0 11-2 0 1 1 0 012 0z" />
                      </svg>
                    </div>
                  </div>
                  <div className="ml-4">
                    <h3 className="text-lg font-medium text-gray-900">Organizations</h3>
                    <p className="text-2xl font-bold text-gray-900">{stats?.total_organizations || 0}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 bg-green-500 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
                      </svg>
                    </div>
                  </div>
                  <div className="ml-4">
                    <h3 className="text-lg font-medium text-gray-900">Total Users</h3>
                    <p className="text-2xl font-bold text-gray-900">{stats?.total_users || 0}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 bg-yellow-500 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                  </div>
                  <div className="ml-4">
                    <h3 className="text-lg font-medium text-gray-900">Active Campaigns</h3>
                    <p className="text-2xl font-bold text-gray-900">{stats?.active_campaigns || 0}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 bg-purple-500 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                    </div>
                  </div>
                  <div className="ml-4">
                    <h3 className="text-lg font-medium text-gray-900">Messages Sent</h3>
                    <p className="text-2xl font-bold text-gray-900">{stats?.total_messages_sent || 0}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Current Role Info */}
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Your Current Access</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">Current Organization</span>
                  <span className="text-sm text-gray-900">{currentOrganization?.organization?.name || 'None selected'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">Your Role</span>
                  <span className="text-sm text-gray-900">
                    {currentOrganization?.role?.split('_').map(word => 
                      word.charAt(0).toUpperCase() + word.slice(1)
                    ).join(' ') || 'No role'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">SaaS Access</span>
                  <span className={`text-sm px-2 py-1 rounded ${hasSaasRole() ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                    {hasSaasRole() ? 'Yes' : 'No'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'organizations' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold text-gray-900">Organizations</h2>
              <button className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                Create Organization
              </button>
            </div>

            <div className="bg-white shadow rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900">
                  {hasSaasRole() ? 'All Organizations' : 'Your Organizations'}
                </h3>
              </div>
              <div className="divide-y divide-gray-200">
                {organizations.length > 0 ? organizations.map((org) => (
                  <div key={org.id} className="px-6 py-4 hover:bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="text-sm font-medium text-gray-900">{org.name}</h4>
                        <p className="text-sm text-gray-500">
                          {org.domain || 'No domain'} • {org.subscription_tier} plan
                        </p>
                      </div>
                      <div className="flex items-center space-x-3">
                        <span className={`px-2 py-1 text-xs rounded ${
                          org.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {org.is_active ? 'Active' : 'Inactive'}
                        </span>
                        <button className="text-indigo-600 hover:text-indigo-900 text-sm font-medium">
                          Manage
                        </button>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="px-6 py-8 text-center">
                    <p className="text-gray-500">No organizations found</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {(activeTab === 'campaigns' || activeTab === 'analytics') && (
          <div className="text-center py-12">
            <div className="w-24 h-24 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
              <svg className="w-12 h-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 7.172V5L8 4z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} Coming Soon
            </h3>
            <p className="text-gray-500">
              This feature is under development and will be available soon.
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

// Onboarding Component
const Onboarding = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Welcome to WhatsApp Automation!</h2>
        <p className="text-gray-600 mb-6">
          Hi {profile?.first_name}! You're not currently a member of any organization. 
          Please contact your administrator to get invited to an organization, or create your own.
        </p>
        <div className="space-y-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="w-full bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            Go to Dashboard
          </button>
          <button
            onClick={() => navigate('/auth')}
            className="w-full border border-gray-300 text-gray-700 px-4 py-2 rounded-lg font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};

// Unauthorized Component
const Unauthorized = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 to-pink-100">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <div className="w-16 h-16 mx-auto mb-4 bg-red-100 rounded-full flex items-center justify-center">
          <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Access Denied</h2>
        <p className="text-gray-600 mb-6">
          You don't have permission to access this resource. Please contact your administrator if you believe this is an error.
        </p>
        <button
          onClick={() => navigate('/dashboard')}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          Go to Dashboard
        </button>
      </div>
    </div>
  );
};

// Main App Component
function App() {
  return (
    <div className="App">
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/auth" element={<AuthForm />} />
            <Route 
              path="/dashboard" 
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/onboarding" 
              element={
                <ProtectedRoute>
                  <Onboarding />
                </ProtectedRoute>
              } 
            />
            <Route path="/unauthorized" element={<Unauthorized />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}

export default App;