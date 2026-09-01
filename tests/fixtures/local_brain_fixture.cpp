#include <csignal>
#include <unistd.h>

int main()
{
    ::signal (SIGTERM, SIG_DFL);
    for (;;) ::pause();
}
