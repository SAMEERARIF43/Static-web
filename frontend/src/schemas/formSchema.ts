import * as z from "zod"

export const formSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(50, "Name must be at most 50 characters"),
  email: z.string().trim().email("Please enter a valid email address"),
  password: z.string().trim().min(8, "Password must be at least 8 characters").max(100, "Password is too long"),
})

export type FormValues = z.infer<typeof formSchema>