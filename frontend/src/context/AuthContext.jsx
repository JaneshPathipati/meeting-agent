// file: frontend/src/context/AuthContext.jsx
import React, { createContext, useReducer, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext(null);

const initialState = {
  user: null,
  profile: null,
  loading: true,
  error: null,
};

function authReducer(state, action) {
  switch (action.type) {
    case 'SET_USER':
      return { ...state, user: action.payload };
    case 'SET_PROFILE':
      return { ...state, profile: action.payload, loading: false };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload, loading: false };
    case 'LOGOUT':
      return { ...initialState, loading: false };
    default:
      return state;
  }
}

function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  useEffect(() => {
    // Check existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        dispatch({ type: 'SET_USER', payload: session.user });
        fetchProfile(session.user.id);
      } else {
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        dispatch({ type: 'SET_USER', payload: session.user });
        fetchProfile(session.user.id);
      } else {
        dispatch({ type: 'LOGOUT' });
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function fetchProfile(authId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('auth_id', authId)
      .single();

    if (error) {
      dispatch({ type: 'SET_ERROR', payload: 'Failed to fetch profile' });
      return;
    }

    if (data.role !== 'admin') {
      await supabase.auth.signOut();
      dispatch({ type: 'SET_ERROR', payload: 'Access denied. Admin only.' });
      return;
    }

    dispatch({ type: 'SET_PROFILE', payload: data });
  }

  async function login(email, password) {
    dispatch({ type: 'SET_LOADING', payload: true });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      dispatch({ type: 'SET_ERROR', payload: error.message });
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  async function logout() {
    await supabase.auth.signOut();
    dispatch({ type: 'LOGOUT' });
  }

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export { AuthContext, AuthProvider };
