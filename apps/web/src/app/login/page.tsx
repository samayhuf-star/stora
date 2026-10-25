import { AuthForm } from '@/components/AuthForm';
import { login } from '@/lib/actions';
export default function Page() { return <main className="center"><AuthForm mode="login" action={login} /></main>; }
