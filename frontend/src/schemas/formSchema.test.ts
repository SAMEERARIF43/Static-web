import { describe, it, expect } from 'vitest'
import { formSchema } from './formSchema'

describe('formSchema', () => {
  describe('valid input', () => {
    it('accepts valid name, email, and password', () => {
      const result = formSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: 'password123',
      })
      expect(result.success).toBe(true)
    })

    it('accepts name at minimum length (2 characters)', () => {
      const result = formSchema.safeParse({
        name: 'Jo',
        email: 'john@example.com',
        password: 'password123',
      })
      expect(result.success).toBe(true)
    })

    it('accepts name at maximum length (50 characters)', () => {
      const result = formSchema.safeParse({
        name: 'A'.repeat(50),
        email: 'john@example.com',
        password: 'password123',
      })
      expect(result.success).toBe(true)
    })

    it('accepts password at minimum length (8 characters)', () => {
      const result = formSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: 'passworD',
      })
      expect(result.success).toBe(true)
    })

    it('accepts various valid email formats', () => {
      const emails = [
        'user@example.com',
        'user.name@example.com',
        'user+tag@example.co.uk',
        'user@subdomain.example.com',
      ]
      for (const email of emails) {
        const result = formSchema.safeParse({
          name: 'John Doe',
          email,
          password: 'password123',
        })
        expect(result.success).toBe(true)
      }
    })
  })

  describe('name validation', () => {
    it('rejects empty name', () => {
      const result = formSchema.safeParse({
        name: '',
        email: 'john@example.com',
        password: 'password123',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Name must be at least 2 characters')
      }
    })

    it('rejects name shorter than 2 characters', () => {
      const result = formSchema.safeParse({
        name: 'J',
        email: 'john@example.com',
        password: 'password123',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Name must be at least 2 characters')
      }
    })

    it('rejects name longer than 50 characters', () => {
      const result = formSchema.safeParse({
        name: 'A'.repeat(51),
        email: 'john@example.com',
        password: 'password123',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Name must be at most 50 characters')
      }
    })

    it('rejects whitespace-only name', () => {
      const result = formSchema.safeParse({
        name: '   ',
        email: 'john@example.com',
        password: 'password123',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Name must be at least 2 characters')
      }
    })
  })

  describe('email validation', () => {
    it('rejects empty email', () => {
      const result = formSchema.safeParse({
        name: 'John Doe',
        email: '',
        password: 'password123',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Please enter a valid email address')
      }
    })

    it('rejects invalid email format', () => {
      const invalidEmails = [
        'not-an-email',
        '@example.com',
        'user@',
        'user@.com',
        'user@exam ple.com',
      ]
      for (const email of invalidEmails) {
        const result = formSchema.safeParse({
          name: 'John Doe',
          email,
          password: 'password123',
        })
        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('Please enter a valid email address')
        }
      }
    })
  })

  describe('password validation', () => {
    it('rejects empty password', () => {
      const result = formSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: '',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Password must be at least 8 characters')
      }
    })

    it('rejects password shorter than 8 characters', () => {
      const result = formSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: 'pass',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Password must be at least 8 characters')
      }
    })

    it('rejects password longer than 100 characters', () => {
      const result = formSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: 'a'.repeat(101),
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Password is too long')
      }
    })

    it('rejects whitespace-only password', () => {
      const result = formSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: '        ',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Password must be at least 8 characters')
      }
    })
  })

  describe('multiple errors', () => {
    it('reports all validation errors at once', () => {
      const result = formSchema.safeParse({
        name: '',
        email: 'invalid',
        password: 'short',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map(i => i.message)
        expect(messages).toContain('Name must be at least 2 characters')
        expect(messages).toContain('Please enter a valid email address')
        expect(messages).toContain('Password must be at least 8 characters')
      }
    })
  })
})