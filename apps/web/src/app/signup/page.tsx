import { AuthForm } from '@/components/AuthForm';
import { signup } from '@/lib/actions';
export default function Page() { return <main className="center"><AuthForm mode="signup" action={signup} /></main>; }
