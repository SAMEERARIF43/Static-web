import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RegistrationForm } from '../components/RegistrationForm'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})

describe('RegistrationForm', () => {
  describe('rendering', () => {
    it('renders all form fields with labels', () => {
      render(<RegistrationForm />)
      expect(screen.getByLabelText('Full Name')).toBeInTheDocument()
      expect(screen.getByLabelText('Email Address')).toBeInTheDocument()
      expect(screen.getByLabelText('Password')).toBeInTheDocument()
    })

    it('renders placeholder text', () => {
      render(<RegistrationForm />)
      expect(screen.getByPlaceholderText('John Doe')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument()
    })

    it('renders helper text for each field', () => {
      render(<RegistrationForm />)
      expect(screen.getByText('Enter your full name')).toBeInTheDocument()
      expect(screen.getByText("We'll never share your email")).toBeInTheDocument()
      expect(screen.getByText('At least 8 characters')).toBeInTheDocument()
    })

    it('renders submit button', () => {
      render(<RegistrationForm />)
      expect(screen.getByRole('button', { name: 'Create Account' })).toBeInTheDocument()
    })
  })

  describe('validation on submit', () => {
    it('shows error for empty name on submit', async () => {
      render(<RegistrationForm />)
      const submitButton = screen.getByRole('button', { name: 'Create Account' })
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(screen.getByText('Name must be at least 2 characters')).toBeInTheDocument()
      })
    })

    it('shows error for empty email on submit', async () => {
      render(<RegistrationForm />)
      await userEvent.type(screen.getByLabelText('Full Name'), 'John Doe')
      const submitButton = screen.getByRole('button', { name: 'Create Account' })
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument()
      })
    })

    

    it('shows error for empty password on submit', async () => {
      render(<RegistrationForm />)
      await userEvent.type(screen.getByLabelText('Full Name'), 'John Doe')
      await userEvent.type(screen.getByLabelText('Email Address'), 'john@example.com')
      const submitButton = screen.getByRole('button', { name: 'Create Account' })
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()
      })
    })

    it('shows error for short password on submit', async () => {
      render(<RegistrationForm />)
      await userEvent.type(screen.getByLabelText('Full Name'), 'John Doe')
      await userEvent.type(screen.getByLabelText('Email Address'), 'john@example.com')
      await userEvent.type(screen.getByLabelText('Password'), 'short')
      const submitButton = screen.getByRole('button', { name: 'Create Account' })
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()
      })
    })

    it('shows error for long name on submit', async () => {
      render(<RegistrationForm />)
      await userEvent.type(screen.getByLabelText('Full Name'), 'A'.repeat(51))
      await userEvent.type(screen.getByLabelText('Email Address'), 'john@example.com')
      await userEvent.type(screen.getByLabelText('Password'), 'password123')
      const submitButton = screen.getByRole('button', { name: 'Create Account' })
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(screen.getByText('Name must be at most 50 characters')).toBeInTheDocument()
      })
    })
  })

  describe('submission', () => {
    it('does not submit with invalid data', async () => {
      render(<RegistrationForm />)
      const submitButton = screen.getByRole('button', { name: 'Create Account' })
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(screen.getByText('Name must be at least 2 characters')).toBeInTheDocument()
      })
      expect(window.alert).not.toHaveBeenCalled()
    })

    it('submits successfully with valid data', async () => {
      render(<RegistrationForm />)
      await userEvent.type(screen.getByLabelText('Full Name'), 'John Doe')
      await userEvent.type(screen.getByLabelText('Email Address'), 'john@example.com')
      await userEvent.type(screen.getByLabelText('Password'), 'password123')
      const submitButton = screen.getByRole('button', { name: 'Create Account' })
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(window.alert).toHaveBeenCalledWith('Form submitted successfully! Check console for values.')
      })
    })
  })

  describe('accessibility', () => {
    it('associates labels with inputs via htmlFor', () => {
      render(<RegistrationForm />)
      const nameInput = screen.getByLabelText('Full Name')
      const nameLabel = screen.getByText('Full Name')
      expect(nameLabel).toHaveAttribute('for', nameInput.id)
    })

    it('sets aria-describedby for hint text', () => {
      render(<RegistrationForm />)
      const nameInput = screen.getByLabelText('Full Name')
      expect(nameInput).toHaveAttribute('aria-describedby')
    })

    it('supports keyboard navigation', () => {
      render(<RegistrationForm />)
      const nameInput = screen.getByLabelText('Full Name')
      const emailInput = screen.getByLabelText('Email Address')
      nameInput.focus()
      expect(document.activeElement).toBe(nameInput)
      fireEvent.keyDown(nameInput, { key: 'Tab' })
      emailInput.focus()
      expect(document.activeElement).toBe(emailInput)
    })
  })

  describe('no real API calls', () => {
    it('does not make network requests on submit', async () => {
      const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue(new Response())
      render(<RegistrationForm />)
      await userEvent.type(screen.getByLabelText('Full Name'), 'John Doe')
      await userEvent.type(screen.getByLabelText('Email Address'), 'john@example.com')
      await userEvent.type(screen.getByLabelText('Password'), 'password123')
      await userEvent.click(screen.getByRole('button', { name: 'Create Account' }))
      await waitFor(() => {
        expect(fetchSpy).not.toHaveBeenCalled()
      })
      fetchSpy.mockRestore()
    })
  })
})