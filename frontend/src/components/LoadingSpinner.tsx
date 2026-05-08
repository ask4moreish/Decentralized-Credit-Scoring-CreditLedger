import React from 'react';

const SIZE = { sm: 'h-4 w-4', md: 'h-8 w-8', lg: 'h-12 w-12' };

export function LoadingSpinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div
      className={`${SIZE[size]} animate-spin rounded-full border-2 border-gray-200 border-t-indigo-600`}
      role="status"
      aria-label="Loading"
    />
  );
}
